import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeChild {
  pid: number | undefined;
  posted: unknown[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(pid: number | undefined) {
    this.pid = pid;
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const state = vi.hoisted(() => ({
  forks: [] as Array<{ modulePath: string; options: { serviceName?: string; env?: object } }>,
  children: [] as unknown[],
  logs: [] as unknown[][],
  spawnWithoutPid: false,
}));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (
      modulePath: string,
      _args: string[],
      options: { serviceName?: string; env?: object }
    ) => {
      state.forks.push({ modulePath, options });
      const child = new FakeChild(
        state.spawnWithoutPid ? undefined : 50_000 + state.children.length
      );
      state.children.push(child);
      return child;
    },
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  logInfo: (...args: unknown[]) => void state.logs.push(args),
  logWarn: (...args: unknown[]) => void state.logs.push(args),
  logError: (...args: unknown[]) => void state.logs.push(args),
}));

type VadModule = typeof import("../openaiVadProcess.js");

let vadModule: VadModule;

function spawn(handlers: Partial<ConstructorParameters<VadModule["OpenAIVadProcess"]>[1]> = {}) {
  const vad = new vadModule.OpenAIVadProcess(7, {
    onMessage: handlers.onMessage ?? vi.fn(),
    onUnexpectedExit: handlers.onUnexpectedExit ?? vi.fn(),
  });
  return { vad, child: state.children.at(-1) as FakeChild };
}

function loggedMessages(): string[] {
  return state.logs.map(([message]) => String(message));
}

beforeEach(async () => {
  state.forks.length = 0;
  state.children.length = 0;
  state.logs.length = 0;
  state.spawnWithoutPid = false;
  vi.resetModules();
  vadModule = await import("../openaiVadProcess.js");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAIVadProcess", () => {
  it("forks the VAD entry without handing it main's secrets", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
    vi.stubEnv("PATH", "/usr/bin");
    spawn();
    const [{ modulePath, options }] = state.forks;
    expect(modulePath.replaceAll("\\", "/")).toMatch(/services\/voice\/openaiVadWorker\.js$/);
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.env).toHaveProperty("PATH", "/usr/bin");
  });

  it("forwards messages while live and stops at retirement", () => {
    const onMessage = vi.fn();
    const { vad, child } = spawn({ onMessage });
    child.emit("message", { type: "speech-start" });
    expect(onMessage).toHaveBeenCalledWith({ type: "speech-start" });

    vad.retire("stop");
    child.emit("message", { type: "speech-end" });
    child.emit("message", { type: "error", message: "late cleanup failure" });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(vad.post({ type: "audio", pcm: new ArrayBuffer(2) })).toBe(false);
    expect(loggedMessages()).toContain(
      "[VoiceTranscription:openai] Retired VAD process reported an error"
    );
  });

  it("asks for a drain once and kills only a process that outlives the drain window", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { vad, child } = spawn();
    vad.retire("session-end");
    vad.retire("session-end");
    expect(child.posted).toEqual([{ type: "destroy" }]);

    vi.advanceTimersByTime(vadModule.VAD_RETIRE_KILL_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledWith(child.pid, "SIGKILL");
  });

  it("clears the kill backstop when the process drains and exits", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { vad, child } = spawn();
    vad.retire("stop");
    child.emit("message", { type: "drained" });
    child.emit("exit", 0);
    vi.advanceTimersByTime(vadModule.VAD_RETIRE_KILL_MS * 2);
    expect(kill).not.toHaveBeenCalled();
    expect(loggedMessages()).toEqual(
      expect.arrayContaining([
        "[VoiceTranscription:openai] VAD drained",
        "[VoiceTranscription:openai] VAD process exited",
      ])
    );
  });

  it("kills a process that only spawns after its drain window closed", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    state.spawnWithoutPid = true;
    const { vad, child } = spawn();
    vad.retire("stop");
    vi.advanceTimersByTime(vadModule.VAD_RETIRE_KILL_MS);
    expect(kill).not.toHaveBeenCalled();

    child.pid = 51_234;
    child.emit("spawn");
    expect(kill).toHaveBeenCalledWith(51_234, "SIGKILL");
  });

  it("treats a zero exit after retirement as clean even if the drained message was lost", () => {
    const { vad, child } = spawn();
    vad.retire("stop");
    child.emit("exit", 0);
    expect(loggedMessages()).toContain("[VoiceTranscription:openai] VAD process exited");
    expect(loggedMessages()).not.toContain(
      "[VoiceTranscription:openai] VAD process exited without a clean drain"
    );
  });

  it("tolerates a process that exits between the pid read and the signal", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const { vad } = spawn();
    vad.retire("stop");
    expect(() => vi.advanceTimersByTime(vadModule.VAD_RETIRE_KILL_MS)).not.toThrow();
    expect(loggedMessages().some((message) => message.includes("SIGKILL"))).toBe(false);
  });

  it("reports an exit it did not ask for, and never asks the dead process to drain", () => {
    const onUnexpectedExit = vi.fn();
    const { vad, child } = spawn({ onUnexpectedExit });
    child.emit("exit", 6);
    expect(onUnexpectedExit).toHaveBeenCalledWith(6);

    vad.retire("degraded");
    expect(child.posted).toEqual([]);
    expect(loggedMessages()).not.toContain("[VoiceTranscription:openai] VAD destroy requested");
  });

  it("warns when a retired process exits without having drained", () => {
    const { vad, child } = spawn();
    vad.retire("stop");
    child.emit("exit", 6);
    expect(loggedMessages()).toContain(
      "[VoiceTranscription:openai] VAD process exited without a clean drain"
    );
  });
});

describe("waitForRetiringVadProcesses", () => {
  it("returns at once when nothing is retiring", async () => {
    await expect(vadModule.waitForRetiringVadProcesses(1_000)).resolves.toBe(0);
  });

  it("settles as soon as every retiring process has exited", async () => {
    const first = spawn();
    const second = spawn();
    first.vad.retire("stop");
    second.vad.retire("stop");

    let settled: number | undefined;
    void vadModule.waitForRetiringVadProcesses(1_000).then((pending) => {
      settled = pending;
    });
    first.child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    second.child.emit("exit", 0);
    await vi.waitFor(() => expect(settled).toBe(0));
  });

  it("gives up at the budget and reports what is still draining", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { vad } = spawn();
    vad.retire("stop");
    const waiting = vadModule.waitForRetiringVadProcesses(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(1);
  });
});
