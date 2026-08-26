import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ASSISTANT_HOST_PROTOCOL_VERSION } from "../../../schemas/ipc.js";
import { assistantChildEnv } from "../assistantChildEnv.js";

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
  /**
   * The run asked for shutdown on the BACKSTOP TIMER rather than on a frame.
   *
   * Worth reporting because the two shutdowns are not equivalent evidence. Teardown
   * cancels an in-flight slow command and only THEN seals the output transport
   * (`teardown` / `sendPriority` in the engine's `internal/host`), so a command the
   * engine never stopped on its own can still post a `command:result` on the way out.
   * A test that reads a result as proof of something the engine did while running has
   * to know the run did not reach the timer, or it is reading teardown's work.
   */
  backstopFired: boolean;
  /**
   * How many frames had arrived when a shutdown was FIRST asked for, or null if none
   * ever was.
   *
   * The companion to `backstopFired`, and the sharper of the two: it dates the request
   * against the wire. A frame at a lower index than this one cannot be teardown's work,
   * whichever route the shutdown came by — which is what a test needs before reading a
   * late-arriving event as something the engine did while it was still running.
   */
  shutdownRequestedAtFrame: number | null;
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
  /**
   * Slash-command lines to send once the engine reports ready, as the panel sends them:
   * `{ type: "command", sessionId, line }`.
   *
   * The panel routes EVERY slash line down this path — it keeps no command list of its
   * own, deliberately, so the two cannot drift — which means the account commands
   * working in the panel is entirely a claim about the engine. Nothing in Daintree's own
   * tree can check it; only driving the real binary can.
   */
  commands?: string[];
  /**
   * Whether to wait for each command's `command:result` before asking for shutdown.
   *
   * `false` sends the commands and the shutdown together, which is the test for the
   * property the engine's `Slow` flag exists to provide: `/login`, `/logout` and
   * `/account` can wait on a browser or a backend round trip, and while they do, the
   * embedded host's command loop must keep servicing everything else. A loop that ran
   * them inline would post nothing and answer nothing until they finished — the panel
   * would simply freeze — so a shutdown that lands promptly IS the assertion.
   *
   * A command the engine REFUSES (`host:error` with `command-busy`) settles here too:
   * it never produces a `command:result`, so counting it would leave the run waiting on
   * the backstop timer for an answer that is never coming.
   */
  awaitCommandResults?: boolean;
  /**
   * Where the engine's backend lives, replacing the default dead loopback port.
   *
   * The default is REFUSED, not silent, and the difference decides whether a command
   * that talks to the backend is slow: a connection to a closed loopback port comes
   * back with ECONNREFUSED in under a millisecond, so `/account` against it answers
   * about as fast as a command that does no I/O at all. A test about what the host does
   * WHILE a command is outstanding needs a socket that accepts and then never answers,
   * which the caller supplies.
   *
   * A LOOPBACK FIXTURE, never a real endpoint — REFUSED below rather than merely asked
   * for. The default is unreachable so that this suite can never do billable work, and
   * an option that could point somewhere real would quietly undo that for every test
   * after it.
   *
   * Named rather than folded into an env bag for the reason `environmentTier` gives:
   * `DAINTREE_ASSISTANT_STATE_DIR` is where a run's supervisor lives and the only thing
   * `stopSupervisor` has to find it by, so it must stay where this harness put it or a
   * run leaves a live supervisor behind a deleted temp tree.
   */
  backendUrl?: string;
  /**
   * Send one `interrupt` frame once this settles, and never before.
   *
   * A promise rather than a delay, for the reason the shutdown below waits on
   * `host:ready` rather than on a grace period: the moment worth interrupting at is a
   * CONDITION, and a timer only guesses at when it holds. The condition that matters is
   * not visible from this side at all — "the command has reached the network" is
   * something only the fixture on the other end of the socket can say — so the caller
   * that owns the fixture supplies it. An interrupt aimed a few milliseconds too early
   * would cancel a context before any I/O began and prove strictly less.
   *
   * Nothing is sent if it never settles; the run then reaches its backstop, which
   * `backstopFired` reports rather than hides.
   */
  interruptWhen?: Promise<unknown>;
}

/** Whether a URL names this machine, and therefore something a test can be holding. */
function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  // Bracketed IPv6 arrives with the brackets stripped by URL, so ::1 compares plainly.
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Boots the engine, sends a descriptor then a shutdown, and collects stdout frames. */
export async function driveEngine(
  binary: string,
  sessionId: string,
  opts: DriveOptions = {}
): Promise<DriveResult> {
  if (opts.backendUrl !== undefined && !isLoopbackUrl(opts.backendUrl)) {
    throw new Error(
      `driveEngine refuses a non-loopback backend (${opts.backendUrl}). ` +
        "This suite drives the real engine, so an endpoint it can actually reach is a " +
        "test that does real work against a real account."
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), "daintree-engine-conformance-"));
  const projectDir = path.join(dir, "project");
  const stateDir = opts.stateDir ?? path.join(dir, "state");
  const descriptorTier = opts.descriptorTier ?? "system";
  try {
    const child = spawn(binary, ["host", "--stdio"], {
      cwd: REPO_ROOT,
      env: {
        // The SAME filter production spawns through, not a raw `process.env`.
        //
        // Every name on that list changes what the engine does, and a test fixture is
        // the worst place to inherit one: `DAINTREE_ASSISTANT_OFFLINE` alone turns a
        // command that was supposed to reach a backend into one that never opens a
        // socket, and the suite would go on passing while asserting nothing. Sharing
        // the production filter also means a name added there for a real session is
        // stripped here without anybody remembering this file exists.
        ...assistantChildEnv(),
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
        DAINTREE_BACKEND_URL: opts.backendUrl ?? "http://127.0.0.1:59999",
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
    const commands = opts.commands ?? [];
    const awaitResults = opts.awaitCommandResults ?? true;
    let outstandingResults = commands.length;
    let stdoutBuffer = "";
    let stderr = "";
    let onReady: (() => void) | undefined;
    let onCommandResult: (() => void) | undefined;
    let onCommandBusy: (() => void) | undefined;

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
        const type = (frame as { type?: string }).type;
        if (type === "host:ready") onReady?.();
        if (type === "command:result") onCommandResult?.();
        if (type === "host:error" && (frame as { code?: string }).code === "command-busy") {
          onCommandBusy?.();
        }
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

    let backstopFired = false;
    let shutdownRequestedAtFrame: number | null = null;
    const exitCode = await new Promise<number | null>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
      const requestShutdown = () => {
        shutdownRequestedAtFrame ??= frames.length;
        if (child.stdin.writable) {
          child.stdin.write(`${JSON.stringify({ type: "shutdown", sessionId })}\n`);
        }
      };
      const settleOne = () => {
        if (!awaitResults) return;
        outstandingResults -= 1;
        if (outstandingResults <= 0) requestShutdown();
      };
      // Shut down on the READY FRAME, not on a timer. A fixed grace period is a guess
      // about how long a 15MB Go binary takes to spawn and reach ready, and that guess
      // fails under a loaded machine — the full suite runs thousands of files in
      // parallel — producing a run whose frames legitimately lack `host:ready` and a
      // flake that reads as a protocol regression. The timer stays only as a backstop
      // for an engine that never becomes ready at all, which is a real failure worth
      // capturing rather than hanging on.
      //
      // With commands, the same rule one step later: send them on ready, then leave on
      // the last result rather than on a guess at how long a backend round trip takes.
      onReady = () => {
        for (const line of commands) {
          if (child.stdin.writable) {
            child.stdin.write(`${JSON.stringify({ type: "command", sessionId, line })}\n`);
          }
        }
        if (commands.length === 0 || !awaitResults) requestShutdown();
      };
      onCommandResult = settleOne;
      onCommandBusy = settleOne;
      // Rejection is swallowed rather than surfaced here: the caller owns this promise
      // and can assert on it directly, and a fixture that failed must not also become an
      // unhandled rejection in whatever test happens to be running when it lands.
      void opts.interruptWhen?.then(
        () => {
          if (child.stdin.writable) {
            child.stdin.write(`${JSON.stringify({ type: "interrupt", sessionId })}\n`);
          }
        },
        () => undefined
      );
      const shutdown = setTimeout(() => {
        // Only when the timer is what ASKED. It is never cancelled on the event path —
        // a shutdown already requested makes it harmless — so setting it unconditionally
        // would report a slow-but-correct teardown as a run that never got its answer.
        backstopFired = shutdownRequestedAtFrame === null;
        requestShutdown();
      }, 20_000);
      // `close`, not `exit`. `exit` fires when the PROCESS is gone, which says nothing
      // about the pipes: bytes already written can still be sitting in the stdio buffers,
      // and reading the frame list at that point drops however much of the tail the
      // event loop had not got to. On a loaded machine that is the last frames of a run
      // — `host:shutdown`, a final `command:result` — and the assertion that goes red is
      // whichever one happened to need them. `close` waits for both streams to end.
      child.on("close", (code) => {
        clearTimeout(kill);
        clearTimeout(shutdown);
        resolve(code);
      });
    });

    // A clean exit that leaves a half-written line is a truncated frame, and a truncated
    // frame is silent: the reader above only ever parses whole lines, so the remainder
    // would simply never be seen. Reported rather than dropped — but only on a clean
    // exit, because a killed engine is EXPECTED to be cut mid-frame, and raising that
    // would bury the real finding (a null exit code) under a parse complaint.
    if (exitCode === 0 && stdoutBuffer.trim() !== "") {
      throw new Error(
        `the engine exited cleanly but left an unterminated frame on stdout: ${stdoutBuffer}`
      );
    }

    return { frames, stderr, exitCode, backstopFired, shutdownRequestedAtFrame };
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
        // Through the same filter, and for a reason of its own: `daemon stop` resolves
        // the FULL config before it asks anything to stop, so an inherited endpoint or
        // key that the engine rejects fails the resolve — and a cleanup that fails is a
        // supervisor left running against a directory this run is about to delete.
        ...assistantChildEnv(),
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
