import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { SimpleGit } from "simple-git";
import {
  GIT_KILL_GRACE_MS,
  _resetGitProcessLifecycleForTesting,
  hasStoppedGitChild,
  superviseGitChildren,
} from "../gitProcessLifecycle.js";

type SpawnAfter = (data: unknown, context: { spawned?: ChildProcess }) => unknown;

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  /** What the OS answers: false once there is no process to signal. */
  delivers = true;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return this.delivers;
  }

  exit(signal: NodeJS.Signals | null = null, events: Array<"exit" | "close"> = ["exit", "close"]) {
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    for (const event of events) this.emit(event, this.exitCode, signal);
  }
}

/** A git instance whose spawn.after plugins can be driven by hand. */
function makeGit(): { git: SimpleGit; spawn: (child: FakeChild) => void } {
  const plugins: SpawnAfter[] = [];
  const git = {
    _plugins: {
      append: (_type: "spawn.after", action: SpawnAfter) => {
        plugins.push(action);
        return () => {};
      },
    },
  } as unknown as SimpleGit;
  return {
    git,
    spawn: (child) => {
      for (const plugin of plugins)
        plugin(undefined, { spawned: child as unknown as ChildProcess });
    },
  };
}

function supervised(dir = "/repo"): FakeChild {
  const { git, spawn } = makeGit();
  superviseGitChildren(git, dir);
  const child = new FakeChild();
  spawn(child);
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetGitProcessLifecycleForTesting();
});

describe("superviseGitChildren", () => {
  it("follows an unanswered SIGINT with exactly one SIGKILL after the grace", () => {
    const child = supervised();

    child.kill("SIGINT");
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS - 1);
    expect(child.signals).toEqual(["SIGINT"]);

    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);

    vi.advanceTimersByTime(GIT_KILL_GRACE_MS * 5);
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("sends nothing more to a child that exits within the grace", () => {
    const child = supervised();

    child.kill("SIGINT");
    child.exit("SIGINT");
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS);

    expect(child.signals).toEqual(["SIGINT"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not escalate a signal that was never delivered", () => {
    const child = supervised();
    child.delivers = false;

    child.kill("SIGINT");
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS);

    expect(child.signals).toEqual(["SIGINT"]);
    expect(hasStoppedGitChild("/repo")).toBe(false);
  });

  it("leaves a child nobody signalled alone", () => {
    supervised();
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS * 10);
    expect(hasStoppedGitChild("/repo")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a stopped child on record, per directory, until it exits", () => {
    const child = supervised("/repo");
    supervised("/other");

    child.kill("SIGINT");
    expect(hasStoppedGitChild("/repo")).toBe(true);
    expect(hasStoppedGitChild("/other")).toBe(false);

    // SIGKILL that the kernel has not acted on yet (an uninterruptible wait)
    // is not an exit.
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS);
    expect(hasStoppedGitChild("/repo")).toBe(true);

    child.exit("SIGKILL");
    expect(hasStoppedGitChild("/repo")).toBe(false);
  });

  it("records a direct SIGKILL without arming another", () => {
    const child = supervised();

    child.kill("SIGKILL");
    expect(hasStoppedGitChild("/repo")).toBe(true);
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS);

    expect(child.signals).toEqual(["SIGKILL"]);
  });

  it("returns what the original kill returned", () => {
    const child = supervised();
    expect(child.kill("SIGINT")).toBe(true);
    child.delivers = false;
    expect(child.kill("SIGINT")).toBe(false);
  });

  it.each([["exit"], ["close"]] as const)(
    "takes `%s` alone as exit evidence",
    (event) => {
      const child = supervised();
      child.kill("SIGINT");
      child.exit("SIGINT", [event]);

      expect(hasStoppedGitChild("/repo")).toBe(false);
      vi.advanceTimersByTime(GIT_KILL_GRACE_MS);
      expect(child.signals).toEqual(["SIGINT"]);
    }
  );

  it("keeps a directory on record until its last stopped child exits", () => {
    const { git, spawn } = makeGit();
    superviseGitChildren(git, "/repo");
    const first = new FakeChild();
    const second = new FakeChild();
    spawn(first);
    spawn(second);

    first.kill("SIGINT");
    second.kill("SIGINT");
    first.exit("SIGINT");
    expect(hasStoppedGitChild("/repo")).toBe(true);

    second.exit("SIGINT");
    expect(hasStoppedGitChild("/repo")).toBe(false);
  });

  it("keeps the first deadline when the child is signalled again", () => {
    const child = supervised();

    child.kill("SIGINT");
    vi.advanceTimersByTime(GIT_KILL_GRACE_MS - 1);
    child.kill("SIGINT");
    vi.advanceTimersByTime(1);

    expect(child.signals).toEqual(["SIGINT", "SIGINT", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills the stopped children still running when the process exits", () => {
    const before = new Set(process.listeners("exit"));
    const stopped = supervised("/repo");
    const healthy = supervised("/other");
    const gone = supervised("/gone");

    stopped.kill("SIGINT");
    gone.kill("SIGINT");
    gone.exit("SIGINT");
    const hooks = process.listeners("exit").filter((listener) => !before.has(listener));
    expect(hooks).toHaveLength(1);
    hooks[0](0);

    expect(stopped.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(healthy.signals).toEqual([]);
    expect(gone.signals).toEqual(["SIGINT"]);
  });

  it("builds without supervision when simple-git's plugin store is missing", () => {
    expect(() => superviseGitChildren({} as SimpleGit, "/repo")).not.toThrow();
  });
});
