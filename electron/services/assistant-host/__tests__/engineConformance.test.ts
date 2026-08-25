import { describe, it, expect } from "vitest";
import { open, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAssistantHostEvent,
  AssistantHostEventSchema,
  ASSISTANT_HOST_PROTOCOL_VERSION,
} from "../../../schemas/ipc.js";
import { binary, driveEngine } from "./engineHarness.js";

/**
 * CROSS-REPO CONFORMANCE.
 *
 * This is the guard for the failure that actually happened to this protocol: Daintree
 * and the engine each described the wire in their own repo, nothing compared the two,
 * and they silently drifted three versions apart. Type-level parity (in
 * `electron/schemas/ipc.ts`) proves Daintree agrees with ITSELF. Only running the real
 * binary proves Daintree agrees with the ENGINE.
 *
 * So this spawns the vendored engine and validates its actual bytes against the Zod
 * schema the main process uses in production. A field the engine renames, drops, or
 * retypes fails here — in a fast unit run — instead of at a user's first turn.
 *
 * It needs no backend and no MCP: booting to `host:ready` and shutting down exercises
 * the handshake, the framing, the sequence stamping, and several event shapes. The
 * engine reports a degraded MCP on stderr and carries on, which is itself part of the
 * contract being asserted (diagnostics never contaminate the protocol stream).
 *
 * The boot harness itself lives in `engineHarness.ts`, shared with the tier-binding
 * suite.
 */

describe.skipIf(!binary)("assistant engine wire conformance", () => {
  it("emits frames that validate against Daintree's own schema", async () => {
    const sessionId = "ses_conformance";
    const { frames, stderr, exitCode } = await driveEngine(binary!, sessionId);

    expect(frames.length, `engine emitted no frames. stderr:\n${stderr}`).toBeGreaterThan(0);

    for (const frame of frames) {
      const parsed = AssistantHostEventSchema.safeParse(frame);
      expect(
        parsed.success,
        `engine emitted a frame Daintree cannot parse — the two repos have drifted.\n` +
          `frame: ${JSON.stringify(frame)}\n` +
          `error: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`
      ).toBe(true);
    }

    expect(exitCode).toBe(0);
  }, 40_000);

  it("agrees on the protocol version", async () => {
    const { frames } = await driveEngine(binary!, "ses_version");
    const ready = frames.map(parseAssistantHostEvent).find((e) => e?.type === "host:ready");

    expect(ready, "engine never signalled host:ready").toBeDefined();
    // The whole point: if these disagree, the submodule pin and Daintree's protocol
    // constant have come apart and every session would be refused at the handshake.
    expect(ready).toMatchObject({ protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION });
  }, 40_000);

  it("stamps a monotonic sequence starting at 1", async () => {
    const { frames } = await driveEngine(binary!, "ses_seq");
    const seqs = frames.map((f) => (f as { seq: number }).seq);

    // seq is what makes a lost frame detectable instead of silent. Starting at 1 lets
    // a consumer treat 0 as "nothing seen yet" without ambiguity.
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  }, 40_000);

  it("boots against a state database from an older schema", async () => {
    // The upgrade path for anyone who has used the assistant before, and it was fatal.
    // The engine hard-resets its SQLite baseline rather than migrating, and the host was
    // the one surface with no recovery wired: it answered `host:error` — "database
    // schema is stale … run 'make db-reset'" — and exited 0, which this side reports as
    // "The assistant engine exited before it was ready". `make` is a developer target no
    // install ships, so there was no way forward from inside the app.
    //
    // Asserted HERE rather than only in the engine's own suite because this is the seam
    // that broke: the reset machinery worked throughout, and what was missing was the
    // host passing the hooks. Only booting the real binary from this side shows that.
    const shared = await mkdtemp(path.join(tmpdir(), "daintree-engine-stale-"));
    try {
      // Boot once so the engine writes a REAL database at the CURRENT baseline. Built
      // by the engine rather than hand-rolled here: a synthetic SQLite file is rejected
      // as malformed long before the version check this test is about.
      await driveEngine(binary!, "ses_seed", { stateDir: shared });

      // Age it. `user_version` is a big-endian u32 at offset 60 of the 100-byte header,
      // so one four-byte write turns a current database into a legacy one without
      // needing a driver or knowing anything about the schema itself.
      const dbPath = path.join(shared, "state.db");
      const handle = await open(dbPath, "r+");
      try {
        await handle.write(Buffer.from([0, 0, 0, 1]), 0, 4, 60);
      } finally {
        await handle.close();
      }

      const { frames, exitCode } = await driveEngine(binary!, "ses_stale", { stateDir: shared });
      const parsed = frames.map(parseAssistantHostEvent);

      const refusal = parsed.find((e) => e?.type === "host:error");
      expect(
        refusal,
        `the engine refused to boot instead of recovering: ${JSON.stringify(refusal)}`
      ).toBeUndefined();
      expect(
        parsed.find((e) => e?.type === "host:ready"),
        "the engine never became ready on a legacy state directory"
      ).toBeDefined();
      expect(exitCode).toBe(0);

      // Recovered, not discarded: the previous database is moved aside, so a user's
      // timers, watchers, memories and history survive an upgrade they did not ask for.
      const backups = (await readdir(shared)).filter((n) => n.startsWith("state.db.bak-v"));
      expect(backups, "the old database was not preserved").toHaveLength(1);
    } finally {
      await rm(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 60_000);

  it("keeps diagnostics off the protocol stream", async () => {
    // The engine reports a degraded MCP connection on a run like this. It must arrive
    // on stderr: a diagnostic on stdout would be an unparseable frame, and the
    // renderer would drop a real event trying to make sense of it.
    const { frames, stderr } = await driveEngine(binary!, "ses_streams");

    expect(stderr).toContain("MCP");
    for (const frame of frames) {
      expect(frame).toHaveProperty("type");
      expect(frame).toHaveProperty("seq");
    }
  }, 40_000);
});
