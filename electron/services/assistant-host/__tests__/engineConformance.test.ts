import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAssistantHostEvent,
  AssistantHostEventSchema,
  ASSISTANT_HOST_PROTOCOL_VERSION,
} from "../../../schemas/ipc.js";

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
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function enginePath(): string | null {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidate = path.join(
    REPO_ROOT,
    "resources",
    "assistant",
    `daintree-assistant-${process.platform}-${process.arch}${suffix}`
  );
  return existsSync(candidate) ? candidate : null;
}

interface DriveResult {
  frames: unknown[];
  stderr: string;
  exitCode: number | null;
}

/** Boots the engine, sends a descriptor then a shutdown, and collects stdout frames. */
async function driveEngine(binary: string, sessionId: string): Promise<DriveResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "daintree-engine-conformance-"));
  const projectDir = path.join(dir, "project");
  try {
    const child = spawn(binary, ["host", "--stdio"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DAINTREE_ASSISTANT_STATE_DIR: path.join(dir, "state"),
        DAINTREE_ASSISTANT_LOG_DIR: path.join(dir, "logs"),
        // Deliberately unreachable. The handshake must not depend on a backend, and
        // pointing at a real one would make this test do billable work.
        DAINTREE_BACKEND_URL: "http://127.0.0.1:59999",
        DAINTREE_ASSISTANT_PROJECT: projectDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const frames: unknown[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let onReady: (() => void) | undefined;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let i: number;
      while ((i = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, i).trim();
        stdoutBuffer = stdoutBuffer.slice(i + 1);
        if (!line) continue;
        const frame: unknown = JSON.parse(line);
        frames.push(frame);
        if ((frame as { type?: string }).type === "host:ready") onReady?.();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.write(
      `${JSON.stringify({
        sessionId,
        windowId: 1,
        projectId: "p_conformance",
        cwd: REPO_ROOT,
        tier: "system",
        protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
      })}\n`
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
      const requestShutdown = () => {
        if (child.stdin.writable) {
          child.stdin.write(`${JSON.stringify({ type: "shutdown", sessionId })}\n`);
        }
      };
      // Shut down on the READY FRAME, not on a timer. A fixed grace period is a guess
      // about how long a 15MB Go binary takes to spawn and reach ready, and that guess
      // fails under a loaded machine — the full suite runs thousands of files in
      // parallel — producing a run whose frames legitimately lack `host:ready` and a
      // flake that reads as a protocol regression. The timer stays only as a backstop
      // for an engine that never becomes ready at all, which is a real failure worth
      // capturing rather than hanging on.
      onReady = requestShutdown;
      const shutdown = setTimeout(requestShutdown, 20_000);
      child.on("exit", (code) => {
        clearTimeout(kill);
        clearTimeout(shutdown);
        resolve(code);
      });
    });

    return { frames, stderr, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const binary = enginePath();

/**
 * In CI the engine MUST be present. Locally it may not be — a fresh clone has an
 * empty submodule, and a test that fails there just teaches people to ignore it.
 *
 * The asymmetry is the point. A conformance test that skips silently is worse than no
 * test: it reports green while proving nothing, which is exactly how a packaging
 * blocker reached a release branch under a passing pipeline.
 */
if (process.env.CI && !binary) {
  throw new Error(
    "The assistant engine is not built, so cross-repo conformance cannot run.\n" +
      "CI must run `npm run build:assistant` (and check out submodules) before vitest.\n" +
      "Skipping here would report a green build that proved nothing."
  );
}

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
