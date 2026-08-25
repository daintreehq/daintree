import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ASSISTANT_HOST_PROTOCOL_VERSION } from "../../../schemas/ipc.js";

/**
 * The shared real-engine harness.
 *
 * Extracted from `engineConformance.test.ts` when the tier-binding tests landed. Both
 * suites need to boot the actual vendored binary and read its actual bytes, and the
 * setup is not incidental — the state directory, the supervisor stop, the shutdown on
 * the ready frame rather than on a timer are each there because a specific flake or a
 * specific orphan process taught them. Two copies of that would drift, and the copy
 * that drifted would be the one reporting green.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

export function enginePath(): string | null {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidate = path.join(
    REPO_ROOT,
    "resources",
    "assistant",
    `daintree-assistant-${process.platform}-${process.arch}${suffix}`
  );
  return existsSync(candidate) ? candidate : null;
}

/**
 * The project this harness claims to be, in BOTH the descriptor and the environment.
 * The engine treats a disagreement between the two as a fatal binding mismatch.
 */
export const CONFORMANCE_PROJECT_ID = "p_conformance";

/**
 * The window this harness claims to be, in BOTH the descriptor and the environment.
 *
 * `windowId` is one of the three fields the engine cross-checks, so it has to be stated
 * on both sides for the same reason `projectId` is — otherwise a `binding-mismatch` test
 * could be satisfied by the wrong field entirely.
 */
const DESCRIPTOR_WINDOW_ID = 1;

export interface DriveResult {
  frames: unknown[];
  stderr: string;
  exitCode: number | null;
}

export interface DriveOptions {
  /** Reuse a state dir across boots, so a second boot sees the first one's database. */
  stateDir?: string;
  /**
   * The descriptor's `tier`, in the ENGINE's vocabulary (`supervisor` / `operator` /
   * `system`). Defaults to `system`, which is what `DAINTREE_ASSISTANT_TIER` resolves
   * to when unset — so a caller that names neither gets a boot that agrees with itself.
   */
  descriptorTier?: string;
  /**
   * `DAINTREE_ASSISTANT_TIER` for the child. Defaults to `descriptorTier`, so a caller
   * that names only one gets a boot that agrees with itself.
   *
   * Deliberately a NAMED option rather than an arbitrary env bag. The tier binding lives
   * half in the descriptor and half in the environment, so a test of it has to set the
   * two independently — but an open bag would also let a caller move
   * `DAINTREE_ASSISTANT_STATE_DIR` or `DAINTREE_ASSISTANT_PROJECT`, which `stopSupervisor`
   * below does NOT read back. A test that did so would leave a real supervisor running
   * against a real state directory after the temp tree was deleted.
   */
  environmentTier?: string;
}

/** Boots the engine, sends a descriptor then a shutdown, and collects stdout frames. */
export async function driveEngine(
  binary: string,
  sessionId: string,
  opts: DriveOptions = {}
): Promise<DriveResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "daintree-engine-conformance-"));
  const projectDir = path.join(dir, "project");
  const stateDir = opts.stateDir ?? path.join(dir, "state");
  const descriptorTier = opts.descriptorTier ?? "system";
  try {
    const child = spawn(binary, ["host", "--stdio"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DAINTREE_ASSISTANT_STATE_DIR: stateDir,
        DAINTREE_ASSISTANT_LOG_DIR: path.join(dir, "logs"),
        // The SAME id the descriptor below carries, because that is what
        // `AssistantHostService` does (`DAINTREE_PROJECT_ID: opts.projectId`). The
        // engine binds its runtime to this variable and refuses a descriptor that
        // disagrees — "the host and the runtime disagree about which session this is,
        // so neither can be trusted to act on it". Leaving it inherited meant the
        // engine bound to whatever project the developer's own shell was in and
        // rejected the handshake before it ever reached ready.
        DAINTREE_PROJECT_ID: CONFORMANCE_PROJECT_ID,
        // Deliberately unreachable. The handshake must not depend on a backend, and
        // pointing at a real one would make this test do billable work.
        DAINTREE_BACKEND_URL: "http://127.0.0.1:59999",
        DAINTREE_ASSISTANT_PROJECT: projectDir,
        // Both halves of the binding are stated EXPLICITLY, never inherited. The engine
        // compares the descriptor against these, and a developer with either of them
        // exported in their shell would otherwise get a refusal that reads as a protocol
        // regression — or, worse, a mismatch test that passed on the wrong field.
        DAINTREE_WINDOW_ID: String(DESCRIPTOR_WINDOW_ID),
        DAINTREE_ASSISTANT_TIER: opts.environmentTier ?? descriptorTier,
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
        windowId: DESCRIPTOR_WINDOW_ID,
        projectId: CONFORMANCE_PROJECT_ID,
        cwd: REPO_ROOT,
        tier: descriptorTier,
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
    // Stop the supervisor BEFORE deleting the directory it lives in.
    //
    // Booting a host also starts a project supervisor, and that supervisor outlives the
    // host deliberately — it is what keeps unattended work running after a window
    // closes. In a test that means one orphan process per run, still polling the shared
    // auth-revision marker inside `stateDir`. Recursive delete empties the tree, the
    // poll recreates `state/auth` in the gap, and the final rmdir fails with ENOTEMPTY —
    // in whichever test happened to lose the race, which reads as a protocol regression
    // rather than the cleanup bug it is.
    await stopSupervisor(binary, stateDir, projectDir);
    // Retries are still worth having: the supervisor is asked to stop, not guaranteed to
    // have finished, and the database's own WAL sidecars settle asynchronously.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * Asks the project supervisor for this state directory to exit, best effort.
 *
 * Failure is ignored on purpose: a run that never got far enough to start one has
 * nothing to stop, and a cleanup helper must not turn that into a test failure.
 */
async function stopSupervisor(binary: string, stateDir: string, projectDir: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(binary, ["daemon", "stop"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DAINTREE_ASSISTANT_STATE_DIR: stateDir,
        DAINTREE_PROJECT_ID: CONFORMANCE_PROJECT_ID,
        DAINTREE_ASSISTANT_PROJECT: projectDir,
      },
      stdio: "ignore",
    });
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const done = () => {
      clearTimeout(kill);
      resolve();
    };
    child.on("exit", done);
    child.on("error", done);
  });
}

export const binary = enginePath();

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
