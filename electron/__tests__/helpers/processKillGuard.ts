import type { ChildProcess, execFileSync as ExecFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, vi, type MockInstance } from "vitest";

export interface ProcessKillViolation {
  pid: number;
  signal: string | number;
  reason: string;
  stack: string;
}

interface GuardState {
  original: typeof process.kill;
  guard: typeof process.kill;
  execFileSync: typeof ExecFileSync;
  // Captured once: tests spoof `process.platform`, and a Windows host pretending
  // to be Linux must not go looking for a process table it doesn't have.
  posix: boolean;
  children: Map<number, WeakRef<ChildProcess>>;
  adopted: Map<number, string>;
  violations: ProcessKillViolation[];
}

// Kept on `process` rather than in module scope: the setup file re-imports this
// module for every test file a reused fork worker runs, and a second wrap would
// capture the first guard as the "original".
const STATE_KEY = Symbol.for("daintree.testProcessKillGuard");

type GuardedProcess = NodeJS.Process & { [STATE_KEY]?: GuardState };

// Absolute, so a test that shims `ps` on PATH can't feed the guard its table.
const PS = "/bin/ps";

function state(): GuardState | undefined {
  return (process as GuardedProcess)[STATE_KEY];
}

function isLiveChild(s: GuardState, pid: number): boolean {
  const child = s.children.get(pid)?.deref();
  if (child && child.exitCode === null && child.signalCode === null) return true;
  s.children.delete(pid);
  return false;
}

function exists(s: GuardState, pid: number): boolean {
  try {
    s.original.call(process, pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function ps(s: GuardState, args: string[]): string | null {
  try {
    return s.execFileSync(PS, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

interface PsRow {
  ppid: number;
  pgid: number;
}

function snapshot(s: GuardState): Map<number, PsRow> | null {
  const out = s.posix ? ps(s, ["-A", "-o", "pid=,ppid=,pgid="]) : null;
  if (out === null) return null;
  const rows = new Map<number, PsRow>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    const [pid, ppid, pgid] = cols.map(Number);
    if (cols.length !== 3 || ![pid, ppid, pgid].every(Number.isInteger)) return null;
    rows.set(pid, { ppid, pgid });
  }
  // A table without this worker in it can't prove anything is ours.
  return rows.has(process.pid) ? rows : null;
}

/** Start time as `ps` prints it: what tells a recycled PID from the one adopted. */
function identity(s: GuardState, pid: number): string | null {
  const out = s.posix ? ps(s, ["-o", "lstart=", "-p", String(pid)])?.trim() : null;
  return out ? out : null;
}

function isSelfOrDescendant(rows: Map<number, PsRow>, pid: number): boolean {
  const seen = new Set<number>();
  for (let cur = pid; cur > 1 && !seen.has(cur); cur = rows.get(cur)?.ppid ?? 0) {
    if (cur === process.pid) return true;
    seen.add(cur);
  }
  return false;
}

// No process holds the PID: the guard answers ESRCH itself rather than
// forwarding the signal, since the PID could be handed out in between.
const ABSENT = Symbol("absent");

/**
 * Why this signal may not be sent, ABSENT when nothing holds the PID, or null
 * when the target is this worker's own.
 */
function refusal(s: GuardState, pid: number): string | typeof ABSENT | null {
  if (pid === 0 || pid === -1) return "it addresses a whole process group or every process";
  if (pid === process.pid || isLiveChild(s, pid)) return null;
  const adopted = s.adopted.get(pid);
  if (adopted !== undefined) {
    if (identity(s, pid) === adopted) return null;
    if (!exists(s, pid)) return ABSENT;
    return "the PID it adopted now belongs to a different process";
  }

  const rows = snapshot(s);
  if (rows) {
    if (pid > 0) {
      if (rows.has(pid)) {
        return isSelfOrDescendant(rows, pid)
          ? null
          : "it is not a process this test worker spawned";
      }
    } else {
      const members = [...rows].filter(([, row]) => row.pgid === -pid).map(([member]) => member);
      if (members.length > 0) {
        if (members.every((member) => isSelfOrDescendant(rows, member))) return null;
        return "its process group holds processes this test worker did not spawn";
      }
    }
  }

  // Not in the table (or no table: Windows, or ps failed). A target that is
  // gone right now gets ESRCH; one that appeared since the snapshot is refused.
  if (!exists(s, pid)) return ABSENT;
  return "it is a live process this test worker did not spawn";
}

/**
 * Wrap `process.kill` for the unit suite so a test can only signal itself and
 * the processes it spawned. A mock pty's made-up PID reaching a real kill path
 * once SIGKILLed whatever unrelated process held that PID (#14418). A refused
 * call sends nothing, throws EPERM like the kernel would, and is recorded so
 * the setup file can fail the test even when the caller swallowed the error.
 */
export function installProcessKillGuard(): void {
  const existing = state();
  if (existing) {
    // An earlier file in this worker may have left an unrestored stub behind.
    if (process.kill !== existing.guard) process.kill = existing.guard;
    return;
  }

  // From the builtin registry rather than an import, so no test file's
  // vi.mock("child_process") can stand in for the real module.
  const childProcess = process.getBuiltinModule("node:child_process");
  const original = process.kill;
  const children = new Map<number, WeakRef<ChildProcess>>();
  const violations: ProcessKillViolation[] = [];
  const s: GuardState = {
    original,
    guard: original,
    execFileSync: childProcess.execFileSync,
    posix: process.platform !== "win32",
    children,
    adopted: new Map(),
    violations,
  };

  // Every spawn, fork and exec goes through this internal method, which the
  // public typings leave out.
  const proto = childProcess.ChildProcess.prototype as unknown as {
    spawn(this: ChildProcess, ...args: unknown[]): unknown;
  };
  const originalSpawn = proto.spawn;
  proto.spawn = function guardedSpawn(this: ChildProcess, ...args: unknown[]) {
    const result = originalSpawn.apply(this, args);
    if (typeof this.pid === "number") children.set(this.pid, new WeakRef(this));
    return result;
  };

  const fail = (code: "EPERM" | "ESRCH", message: string): never => {
    const err = new Error(`kill ${code}: ${message}`) as NodeJS.ErrnoException;
    err.code = code;
    err.errno = code === "EPERM" ? -1 : -3;
    err.syscall = "kill";
    throw err;
  };

  s.guard = function guardedKill(pid: number, signal?: string | number): true {
    // Node takes numeric strings too, so "456" must be judged as 456.
    const target = typeof pid === "string" ? Number(pid) : pid;
    if (signal !== 0 && Number.isInteger(target)) {
      const verdict = refusal(s, target);
      if (verdict === ABSENT) fail("ESRCH", `no process holds pid ${target}`);
      if (typeof verdict === "string") {
        const sig = signal ?? "SIGTERM";
        const message = `the unit-test guard refused process.kill(${target}, ${String(sig)}) because ${verdict}`;
        const stack = new Error(message).stack ?? message;
        violations.push({ pid: target, signal: sig, reason: verdict, stack });
        fail("EPERM", message);
      }
    }
    return original.call(process, pid, signal);
  } as typeof process.kill;

  (process as GuardedProcess)[STATE_KEY] = s;
  process.kill = s.guard;
}

/**
 * Let the current test signal a process it created that is no longer its
 * descendant, such as a grandchild orphaned to init or a daemonised ssh master.
 * The process's start time is recorded now and checked again before any
 * signal, so a PID recycled after adoption is refused, and the permission ends
 * with the test.
 */
export function adoptProcessForKill(pid: number): void {
  const s = state();
  if (!s || !Number.isInteger(pid) || pid <= 1) return;
  const id = identity(s, pid);
  if (id !== null) s.adopted.set(pid, id);
}

/** Return and clear every refused `process.kill` call, and end every adoption. */
export function takeProcessKillViolations(): ProcessKillViolation[] {
  const s = state();
  if (!s) return [];
  s.adopted.clear();
  return s.violations.splice(0);
}

export function formatProcessKillViolations(violations: ProcessKillViolation[]): string {
  return [
    "A unit test tried to signal a process it does not own, and the kill guard refused it.",
    "A mock PID reached a real kill path: stub the signal instead, for example",
    'vi.spyOn(process, "kill").mockImplementation(() => true), and assert on the stub.',
    ...violations.map(
      (v) => `\nprocess.kill(${v.pid}, ${String(v.signal)}): ${v.reason}\n${v.stack}`
    ),
  ].join("\n");
}

/**
 * Stub `process.kill` for every test in the calling file, for suites that hand
 * mock PIDs to a real kill path. The stub stays in place across tests and
 * outlives the last one by `settleMs`, so a SIGKILL escalation a test armed
 * with real timers lands on the stub rather than on the guard in a later test
 * or file. Returns a getter for the current spy, cleared before each test.
 */
export function stubProcessKillForFile(settleMs = 0): () => MockInstance<typeof process.kill> {
  let spy: MockInstance<typeof process.kill> | null = null;
  const install = () => {
    spy = vi.spyOn(process, "kill").mockImplementation(() => true);
  };
  beforeAll(install);
  beforeEach(() => {
    // A test's vi.restoreAllMocks() takes the stub down with its own spies.
    if (!spy || !vi.isMockFunction(process.kill)) install();
    else spy.mockClear();
  });
  afterAll(async () => {
    if (settleMs > 0) {
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    spy?.mockRestore();
  });
  return () => spy!;
}
