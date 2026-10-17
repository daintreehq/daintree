import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import { TREE_KILL_SENTINEL_PREFIX } from "../../windowsTreeKillService.js";

/** A stand-in for the persistent tree-kill helper's `powershell.exe`. */
export interface FakeTreeKillHelper {
  child: ChildProcess;
  /** Request lines received on stdin, without their newline. */
  requests: string[];
  /** Request ids in arrival order. */
  readonly requestIds: number[];
  /** The roots' PIDs in request `n`, as the JSON carried them. */
  rootsOf(n: number): number[];
  /** Raw text on stdout. */
  write(text: string): void;
  /** A complete answer to request `n` (default: the latest): the lines, END, and its sentinel. */
  answer(lines: string[], n?: number): void;
  /** The process ends on its own. */
  die(code?: number): void;
  killed: boolean;
  stdinEnded: boolean;
  /** Whether `kill()` ends the process; false models one that will not die. */
  dieOnKill: boolean;
}

export function createFakeTreeKillHelper(pid = 4242): FakeTreeKillHelper {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: EventEmitter & { write: (line: string) => boolean; end: () => void };
    kill: () => boolean;
    unref: () => void;
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new EventEmitter() as EventEmitter & {
    write: (line: string) => boolean;
    end: () => void;
  };
  let closed = false;

  const helper: FakeTreeKillHelper = {
    child: child as unknown as ChildProcess,
    requests: [],
    get requestIds() {
      return helper.requests.map((line) => Number(line.slice(0, line.indexOf(" "))));
    },
    rootsOf(n) {
      const line = helper.requests[n];
      const input = JSON.parse(line.slice(line.indexOf(" ") + 1)) as {
        roots: Array<{ pid: number }>;
      };
      return input.roots.map((root) => root.pid);
    },
    write(text) {
      stdout.write(text);
    },
    answer(lines, n = helper.requests.length - 1) {
      const id = helper.requestIds[n];
      stdout.write([...lines, "END", `${TREE_KILL_SENTINEL_PREFIX}${id}`, ""].join("\r\n"));
    },
    die(code = 1) {
      close(code, null);
    },
    killed: false,
    stdinEnded: false,
    dieOnKill: true,
  };

  // `close` follows the end of stdout, as Node's does once the pipes drain.
  function close(code: number | null, signal: string | null): void {
    if (closed) return;
    closed = true;
    stdout.once("end", () => child.emit("close", code, signal));
    stdout.end();
    stdout.resume();
  }

  stdin.write = (line: string) => {
    helper.requests.push(line.replace(/\n$/, ""));
    return true;
  };
  stdin.end = () => {
    helper.stdinEnded = true;
  };
  child.pid = pid;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => {
    helper.killed = true;
    if (helper.dieOnKill) close(null, "SIGTERM");
    return true;
  };
  child.unref = () => {};
  return helper;
}

/** Let queued dispatches, stream data and closes run. */
export async function settleIo(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
