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

/**
 * The engine advertises the account commands, so the panel can offer them.
 *
 * This is the cross-repo half of sign-in, and it is the one that can rot silently.
 * Daintree renders its slash palette from the catalog the engine hands over in
 * `host:ready` — it keeps no list of its own, deliberately, so that the two cannot
 * drift. The consequence is that `/login` working in the panel is entirely a claim
 * about the ENGINE, and nothing in Daintree's own tree can verify it.
 *
 * The failure this guards is concrete and was real until the engine gained these
 * commands: Daintree removed its Settings account surface on the understanding that
 * sign-in had moved into the session, while a `/login` typed into the panel took the
 * unknown-command path and came back as "/login isn't a command" — leaving an install
 * with no way to sign in at all, and a complete OAuth implementation sitting one
 * registry row out of reach.
 */
describe.skipIf(!binary)("assistant engine account commands", () => {
  it("advertises the sign-in commands in the ready catalog", async () => {
    const { frames, stderr } = await driveEngine(binary!, "ses_account_commands");
    const ready = frames.map(parseAssistantHostEvent).find((e) => e?.type === "host:ready") as
      { commands?: { name: string }[] } | undefined;

    expect(ready, `the engine never became ready.\n${stderr}`).toBeDefined();

    const names = (ready?.commands ?? []).map((c) => c.name);
    expect(
      names.length,
      "the engine advertised no commands at all — the panel's palette would be empty"
    ).toBeGreaterThan(0);

    // Asserted WITH the leading slash, because that is what the engine puts on the wire
    // and what the panel renders verbatim. Matching on the bare word would pass on a
    // catalog whose entries the panel cannot display as typed.
    //
    // `/backend` sits with the three sign-in commands rather than with `/status`: it is
    // the OTHER half of the same ownership move. Daintree removed its backend-URL
    // setting on the understanding that the endpoint became the engine's own business,
    // chosen in-session and remembered across restarts — so an engine that stopped
    // advertising it would leave an install signed in to an endpoint with no way to
    // change it, which is the same dead end `/login` going missing produced.
    for (const command of ["/login", "/logout", "/account", "/backend"]) {
      expect(
        names,
        `the engine does not advertise ${command}, so the panel cannot offer it — ` +
          `advertised: ${names.join(", ")}`
      ).toContain(command);
    }
  }, 40_000);

  it("answers an account command with a structured result, not prose in a turn", async () => {
    // What the panel does with a slash line: sends `{type:"command"}` and renders the
    // `command:result` it gets back. The distinction being pinned is that the answer
    // arrives as its OWN event with the command echoed on it — not as an assistant turn,
    // and not as text the host would have to interpret.
    //
    // The backend is unreachable here by construction (the harness pins
    // DAINTREE_BACKEND_URL at a dead loopback port), so this also covers the case the
    // account contract most needs to get right: a dependency that cannot answer must
    // come back as a typed result the host can render, never as a hang and never as
    // silence. Daintree renders whatever text this carries; it must not read it.
    const { frames, stderr } = await driveEngine(binary!, "ses_account_result", {
      commands: ["/account"],
    });
    const results = frames
      .map(parseAssistantHostEvent)
      .filter((e) => e?.type === "command:result") as {
      command: string;
      text: string;
      unknown?: boolean;
    }[];

    expect(results.length, `no command:result came back for /account.\n${stderr}`).toBe(1);
    expect(
      results[0].unknown,
      "the engine did not recognise /account, so the panel would have sent it as a prompt"
    ).toBeFalsy();
    expect(results[0].command).toBe("/account");
    expect(
      results[0].text.length,
      "an empty result renders as a blank line in the panel"
    ).toBeGreaterThan(0);
  }, 60_000);

  it("keeps servicing the host loop while a slow account command is still working", async () => {
    // The property `Slow` exists for (internal/commands/registry.go): `/login`,
    // `/logout` and `/account` can wait on a browser or a backend round trip, and the
    // embedded host runs commands on its command loop. Run inline, those minutes are
    // minutes in which the loop services no interrupt, no approval and no shutdown and
    // posts nothing — the panel freezes with no way out. The engine dispatches them to a
    // worker instead.
    //
    // So: send the command and the shutdown together, without waiting. A prompt, clean
    // exit is the assertion — a loop blocked on the command would sit until the harness
    // killed it, and the kill shows up as a null exit code.
    const { exitCode, stderr } = await driveEngine(binary!, "ses_slow_command", {
      commands: ["/account"],
      awaitCommandResults: false,
    });

    expect(exitCode, `the engine did not exit cleanly while a slow command ran.\n${stderr}`).toBe(
      0
    );
  }, 60_000);
});
