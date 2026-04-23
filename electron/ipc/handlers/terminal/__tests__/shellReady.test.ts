import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { waitForShellReady } from "../shellReady.js";

function createEmitterPtyClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    hasTerminal: vi.fn(() => true),
  });
}

async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe("waitForShellReady", () => {
  let ptyClient: ReturnType<typeof createEmitterPtyClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    ptyClient = createEmitterPtyClient();
  });

  afterEach(() => {
    ptyClient.removeAllListeners();
    vi.useRealTimers();
  });

  it("resolves after quiescence once a prompt character is observed", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "$ ");
    await flush(199);
    expect(resolved).not.toHaveBeenCalled();

    await flush(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("ignores data for other terminals", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1", { timeoutMs: 1000 }).then(resolved);

    ptyClient.emit("data", "t2", "$ ");
    await flush(500);
    expect(resolved).not.toHaveBeenCalled();

    ptyClient.emit("data", "t1", "$ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("resets quiescence when new data arrives after the first prompt", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "❯ "); // p10k instant prompt
    await flush(150);
    expect(resolved).not.toHaveBeenCalled();

    ptyClient.emit("data", "t1", "\r\n❯ "); // real prompt redraw
    await flush(150);
    expect(resolved).not.toHaveBeenCalled();

    await flush(50);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("waits past arbitrary RC-file output before the first prompt", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "loading nvm...\r\n");
    await flush(500);
    ptyClient.emit("data", "t1", "sourcing zshrc...\r\n");
    await flush(800);
    expect(resolved).not.toHaveBeenCalled();

    ptyClient.emit("data", "t1", "$ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("resolves on exit so the caller can skip the write", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("exit", "t1", 0);
    await flush(0);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("resolves on hard timeout when no prompt ever appears", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1", { timeoutMs: 5000 }).then(resolved);

    await flush(4999);
    expect(resolved).not.toHaveBeenCalled();

    await flush(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("removes all listeners on every resolution path", async () => {
    const p1 = waitForShellReady(ptyClient, "t1");
    const p2 = waitForShellReady(ptyClient, "t2", { timeoutMs: 1000 });
    const p3 = waitForShellReady(ptyClient, "t3");

    // Happy path
    ptyClient.emit("data", "t1", "$ ");
    await flush(200);
    await p1;

    // Timeout path
    await flush(1000);
    await p2;

    // Exit path
    ptyClient.emit("exit", "t3", 0);
    await flush(0);
    await p3;

    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("detects prompt characters even when preceded by other output in the same chunk", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "welcome\r\n$ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("strips ANSI escapes before matching the prompt", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    // colored prompt with ANSI wrap
    ptyClient.emit("data", "t1", "\x1b[32m$\x1b[0m ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("detects prompts separated by a carriage return only (no newline)", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "checking env...\r$ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("matches common bash-style `user@host dir $` prompts", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "\r\ngpriday@studio ~/project $ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("matches oh-my-zsh arrow-theme prompts", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "\r\n➜  project git:(main) ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("does not false-positive on RC output that contains a prompt character mid-line", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1", { timeoutMs: 2000 }).then(resolved);

    ptyClient.emit("data", "t1", "# loading plugin foo\r\n");
    ptyClient.emit("data", "t1", "error: $VAR not set\r\n");
    await flush(500);
    expect(resolved).not.toHaveBeenCalled();

    // Real prompt arrives after the noise — that's what resolves.
    ptyClient.emit("data", "t1", "$ ");
    await flush(200);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("short-circuits via exit even when quiescence timer is running", async () => {
    const resolved = vi.fn();
    waitForShellReady(ptyClient, "t1").then(resolved);

    ptyClient.emit("data", "t1", "$ ");
    await flush(100); // inside 200ms quiescence
    expect(resolved).not.toHaveBeenCalled();

    ptyClient.emit("exit", "t1", 0);
    await flush(0);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("does not cross-inject between concurrent terminals", async () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    waitForShellReady(ptyClient, "t1").then(r1);
    waitForShellReady(ptyClient, "t2").then(r2);

    ptyClient.emit("data", "t1", "$ ");
    await flush(200);
    expect(r1).toHaveBeenCalledTimes(1);
    expect(r2).not.toHaveBeenCalled();

    ptyClient.emit("data", "t2", "$ ");
    await flush(200);
    expect(r2).toHaveBeenCalledTimes(1);
  });
});
