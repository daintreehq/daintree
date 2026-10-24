import { ChildProcess, execFileSync } from "node:child_process";

export interface ProcessKillViolation {
  pid: number;
  signal: string | number;
  reason: string;
}

interface GuardState {
  original: typeof process.kill;
  guard: typeof process.kill;
  children: Map<number, WeakRef<ChildProcess>>;
  adopted: Set<number>;
  violations: ProcessKillViolation[];
}

// Kept on `process` rather than in module scope: the setup file re-imports this
// module for every test file a reused fork worker runs, and a second wrap would
// capture the first guard as the "original".
const STATE_KEY = Symbol.for("daintree.testProcessKillGuard");

type GuardedProcess = NodeJS.Process & { [STATE_KEY]?: GuardState };

function state(): GuardState | undefined {
  return (process as GuardedProcess)[STATE_KEY];
}

function isLiveChild(s: GuardState, pid: number): boolean {
  const child = s.children.get(pid)?.deref();
  return !!child && child.exitCode === null && child.signalCode === null;
}

function exists(s: GuardState, pid: number): boolean {
  try {
    s.original.call(process, pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface PsRow {
  ppid: number;
  pgid: number;
}

function snapshot(): Map<number, PsRow> | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = new Map<number, PsRow>();
    for (const line of out.split("\n")) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.set(pid, { ppid, pgid });
    }
    return rows.size > 0 ? rows : null;
  } catch {
    return null;
  }
}

function isSelfOrDescendant(rows: Map<number, PsRow>, pid: number): boolean {
  const seen = new Set<number>();
  for (let cur = pid; cur > 1 && !seen.has(cur); cur = rows.get(cur)?.ppid ?? 0) {
    if (cur === process.pid) return true;
    seen.add(cur);
  }
  return false;
}

/** Why this signal may not be sent, or null when the target is this worker's own. */
function refusal(s: GuardState, pid: number): string | null {
  if (pid === process.pid || isLiveChild(s, pid) || s.adopted.has(pid)) return null;
  if (pid === 0 || pid === -1) return "it addresses a whole process group or every process";
  if (pid < 0 && isLiveChild(s, -pid)) return null;

  const rows = snapshot();
  if (rows) {
    if (pid > 0) {
      if (!rows.has(pid)) return null;
      return isSelfOrDescendant(rows, pid) ? null : "it is not a process this test worker spawned";
    }
    const members = [...rows].filter(([, row]) => row.pgid === -pid).map(([member]) => member);
    if (members.every((member) => isSelfOrDescendant(rows, member))) return null;
    return "its process group holds processes this test worker did not spawn";
  }

  // No process table (Windows, or ps unavailable): only a PID that is already
  // gone is safe to pass through, since the real call then just reports ESRCH.
  if (!exists(s, pid)) return null;
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

  const original = process.kill;
  const children = new Map<number, WeakRef<ChildProcess>>();
  const violations: ProcessKillViolation[] = [];
  const s: GuardState = { original, guard: original, children, adopted: new Set(), violations };

  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function guardedSpawn(this: ChildProcess, ...args) {
    const result = originalSpawn.apply(this, args);
    if (typeof this.pid === "number") children.set(this.pid, new WeakRef(this));
    return result;
  } as typeof originalSpawn;

  s.guard = function guardedKill(pid: number, signal?: string | number): true {
    const sig = signal ?? "SIGTERM";
    if (sig !== 0) {
      const reason = refusal(s, pid);
      if (reason) {
        violations.push({ pid, signal: sig, reason });
        const err = new Error(
          `kill EPERM: the unit-test guard refused process.kill(${pid}, ${String(sig)}) because ${reason}`
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        err.errno = -1;
        err.syscall = "kill";
        throw err;
      }
    }
    return original.call(process, pid, signal);
  } as typeof process.kill;

  (process as GuardedProcess)[STATE_KEY] = s;
  process.kill = s.guard;
}

/**
 * Let the current test signal a process it created that is no longer its
 * descendant, such as a grandchild orphaned to init on purpose. The permission
 * ends with the test, so a recycled PID is never covered by it.
 */
export function adoptProcessForKill(pid: number): void {
  state()?.adopted.add(pid);
}

/** Return and clear every refused `process.kill` call, and end every adoption. */
export function takeProcessKillViolations(): ProcessKillViolation[] {
  const s = state();
  if (!s) return [];
  s.adopted.clear();
  return s.violations.splice(0);
}

export function formatProcessKillViolations(violations: ProcessKillViolation[]): string {
  const lines = violations.map(
    (v) => `  process.kill(${v.pid}, ${String(v.signal)}): ${v.reason}`
  );
  return [
    "A unit test tried to signal a process it does not own, and the kill guard refused it:",
    ...lines,
    "A mock PID reached a real kill path. Stub the signal instead, for example",
    "vi.spyOn(process, \"kill\").mockImplementation(() => true), and assert on the stub.",
  ].join("\n");
}
