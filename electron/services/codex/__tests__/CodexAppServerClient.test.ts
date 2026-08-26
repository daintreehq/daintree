import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("../../../utils/spawnEnv.js", () => ({
  buildProbeEnv: () => ({ PATH: "/usr/bin" }),
}));

import { CodexAppServerError, runCodexAppServerSession } from "../CodexAppServerClient.js";

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

class FakeStdin extends EventEmitter {
  readonly lines: string[] = [];
  ended = false;
  write(chunk: string) {
    this.lines.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();
  pid = 4242;
  unref = vi.fn();

  /** Parsed requests the client has written, in order. */
  get requests(): Array<{ id?: number; method: string; params?: unknown }> {
    return this.stdin.lines.map((line) => JSON.parse(line));
  }

  emitLines(...lines: string[]) {
    this.stdout.emit("data", Buffer.from(lines.map((line) => `${line}\n`).join("")));
  }

  /** Answer whatever the client most recently asked, by request id. */
  respondTo(method: string, result: unknown) {
    const request = this.requests.find(
      (entry) => entry.method === method && entry.id !== undefined
    );
    if (!request) throw new Error(`no pending request for ${method}`);
    this.emitLines(JSON.stringify({ id: request.id, result }));
  }
}

let child: FakeChild;

/** Let queued microtasks (the client's promise plumbing) run. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Complete the handshake so a test can get at the caller's `call`. */
async function startSession<T>(run: Parameters<typeof runCodexAppServerSession<T>>[0]) {
  const promise = runCodexAppServerSession(run, { command: "codex-test" });
  await flush();
  child.respondTo("initialize", { userAgent: "codex" });
  await flush();
  return promise;
}

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
  spawnSyncMock.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCodexAppServerSession", () => {
  it("handshakes with experimental capabilities before running the caller", async () => {
    const seen: string[] = [];
    const result = await startSession(async (call) => {
      seen.push(...child.requests.map((entry) => entry.method));
      const listPromise = call<{ data: unknown[] }>("thread/list", { limit: 1 });
      await flush();
      child.respondTo("thread/list", { data: [{ id: "a" }] });
      return listPromise;
    });

    expect(result).toEqual({ data: [{ id: "a" }] });
    // initialize is a request; initialized is a notification with no id.
    const initialize = child.requests[0];
    expect(initialize.method).toBe("initialize");
    expect(initialize.params).toMatchObject({ capabilities: { experimentalApi: true } });
    const initialized = child.requests[1];
    expect(initialized.method).toBe("initialized");
    expect(initialized.id).toBeUndefined();
    // The caller's own query must come after the handshake, never before.
    expect(seen).toEqual(["initialize", "initialized"]);
  });

  it("refuses methods outside the read-only allowlist without writing to stdin", async () => {
    const error = await startSession(async (call) =>
      call("thread/start", { cwd: "/repo" }).then(
        () => null,
        (err: unknown) => err
      )
    );

    expect(error).toBeInstanceOf(CodexAppServerError);
    expect((error as CodexAppServerError).message).toContain("thread/start");
    // Only the two handshake frames were ever written.
    expect(child.requests.map((entry) => entry.method)).toEqual(["initialize", "initialized"]);
  });

  it("resolves interleaved responses by id, ignoring notifications and split frames", async () => {
    const result = await startSession(async (call) => {
      const first = call<{ tag: string }>("thread/list");
      const second = call<{ tag: string }>("thread/read");
      await flush();
      const ids = child.requests.filter((entry) => entry.id !== undefined).map((entry) => entry.id);
      const [, listId, readId] = ids;

      // A notification (no id) between responses must not consume either.
      child.emitLines(JSON.stringify({ method: "thread/started", params: {} }));
      // Answer out of order.
      child.emitLines(JSON.stringify({ id: readId, result: { tag: "read" } }));
      // Deliver the remaining response across two chunks, split mid-JSON.
      const payload = `${JSON.stringify({ id: listId, result: { tag: "list" } })}\n`;
      child.stdout.emit("data", Buffer.from(payload.slice(0, 12)));
      child.stdout.emit("data", Buffer.from(payload.slice(12)));

      return { list: await first, read: await second };
    });

    expect(result).toEqual({ list: { tag: "list" }, read: { tag: "read" } });
  });

  it("surfaces a JSON-RPC error as a protocol-error rejection", async () => {
    const error = await startSession(async (call) => {
      const pending = call("thread/list").then(
        () => null,
        (err: unknown) => err
      );
      await flush();
      const id = child.requests.filter((entry) => entry.id !== undefined).at(-1)?.id;
      child.emitLines(
        JSON.stringify({ id, error: { code: -32001, message: "Server overloaded" } })
      );
      return pending;
    });

    expect(error).toBeInstanceOf(CodexAppServerError);
    expect((error as CodexAppServerError).reason).toBe("protocol-error");
    expect((error as CodexAppServerError).message).toContain("Server overloaded");
  });

  it("reports a missing CLI distinctly from a protocol failure", async () => {
    spawnMock.mockImplementationOnce(() => {
      const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    await expect(runCodexAppServerSession(async () => "unused")).rejects.toMatchObject({
      reason: "cli-missing",
    });
  });

  it("rejects every in-flight request once when the server dies mid-query", async () => {
    const outcome = await startSession(async (call) => {
      const first = call("thread/list").then(
        () => "resolved",
        (err: unknown) => (err as Error).message
      );
      const second = call("thread/read").then(
        () => "resolved",
        (err: unknown) => (err as Error).message
      );
      await flush();
      child.stderr.emit("data", Buffer.from("panicked at codex"));
      child.emit("close");
      return Promise.all([first, second]);
    });

    expect(outcome[0]).toContain("exited early");
    expect(outcome[1]).toContain("exited early");
    // stderr is folded into the message so a crash is diagnosable.
    expect(outcome[0]).toContain("panicked at codex");
  });

  it("reaps the process group when the session ends", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await startSession(async () => "done");

    // Negative pid = whole group, so a grandchild holding the pipe goes too.
    expect(killSpy).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(child.stdin.ended).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("keeps stream error sinks alive after teardown so a late EIO is not fatal", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await startSession(async () => "done");

    // An unhandled 'error' on a stream is fatal in the main process; emitting
    // one after dispose must stay absorbed.
    expect(() => child.stdout.emit("error", new Error("EIO"))).not.toThrow();
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  });

  it("aborts on a frame that never terminates instead of buffering it forever", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const error = await startSession(async (call) => {
      const pending = call("thread/list").then(
        () => null,
        (err: unknown) => err
      );
      await flush();
      // 5MB with no newline: not a response, just an unbounded frame.
      child.stdout.emit("data", Buffer.from("x".repeat(5 * 1024 * 1024)));
      return pending;
    });

    expect((error as CodexAppServerError).message).toContain("exceeded limit");
  });

  it("classifies an asynchronous ENOENT the same as a synchronous one", async () => {
    // `spawn` reports a missing binary through an 'error' event, not a throw,
    // whenever the failure is detected after the call returns.
    const promise = runCodexAppServerSession(async () => "unused", {
      command: "codex-test",
    }).catch((error: unknown) => error);
    await flush();
    const enoent = new Error("spawn codex-test ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    child.emit("error", enoent);

    expect(await promise).toMatchObject({ reason: "cli-missing" });
  });

  it("drops a response that arrives after its request timed out, leaving others correlated", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const promise = runCodexAppServerSession(
      async (call) => {
        const stale = call("thread/list").then(
          () => "resolved",
          (err: unknown) => (err as CodexAppServerError).reason
        );
        await vi.advanceTimersByTimeAsync(0);
        const staleId = child.requests.filter((entry) => entry.id !== undefined).at(-1)?.id;

        // Blow the per-request budget on the first call only.
        await vi.advanceTimersByTimeAsync(10_001);
        const staleOutcome = await stale;

        const live = call<{ tag: string }>("thread/read");
        await vi.advanceTimersByTimeAsync(0);
        // The late response for the abandoned id must not satisfy the new call.
        child.emitLines(JSON.stringify({ id: staleId, result: { tag: "stale" } }));
        const liveId = child.requests.filter((entry) => entry.id !== undefined).at(-1)?.id;
        expect(liveId).not.toBe(staleId);
        child.emitLines(JSON.stringify({ id: liveId, result: { tag: "live" } }));

        return { staleOutcome, live: await live };
      },
      { command: "codex-test", timeoutMs: 60_000 }
    );

    await vi.advanceTimersByTimeAsync(0);
    child.respondTo("initialize", { userAgent: "codex" });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual({ staleOutcome: "timeout", live: { tag: "live" } });
  });

  it("rejects a call made after the session was torn down", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    let escaped: ((method: string) => Promise<unknown>) | null = null;

    await startSession(async (call) => {
      escaped = call;
      return "done";
    });

    await expect(escaped!("thread/list")).rejects.toBeInstanceOf(CodexAppServerError);
  });

  it("caps how many app-servers run at once so a project restore can't burst", async () => {
    // Every Codex pane asks for its own subagents when a project restores;
    // ungated that is one child process per pane, all at the same instant.
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const next = new FakeChild();
      children.push(next);
      return next;
    });
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const handshakeAll = async () => {
      await flush();
      for (const spawned of children) {
        if (
          spawned.requests.some((entry) => entry.method === "initialize" && entry.id !== undefined)
        ) {
          try {
            spawned.respondTo("initialize", {});
          } catch {
            // Already answered on an earlier pass.
          }
        }
      }
      await flush();
    };

    const release: Array<() => void> = [];
    const sessions = Array.from({ length: 5 }, () =>
      runCodexAppServerSession(
        () => new Promise<string>((resolve) => release.push(() => resolve("done"))),
        { command: "codex-test" }
      )
    );

    await handshakeAll();
    // The gate is what keeps this below the number of callers.
    const spawnedWhileGated = children.length;

    // Drain: each completion frees a slot, which spawns and handshakes the next.
    while (release.length > 0) {
      release.shift()?.();
      await handshakeAll();
    }
    await Promise.all(sessions);

    expect(spawnedWhileGated).toBeLessThan(sessions.length);
    // Every queued session still runs once a slot frees.
    expect(children.length).toBe(sessions.length);
  });

  it("times the whole session out and reaps rather than hanging on a silent server", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const promise = runCodexAppServerSession(async () => "unreachable", {
      command: "codex-test",
      timeoutMs: 50,
    }).catch((error: unknown) => error);

    // The server never answers `initialize`.
    await vi.advanceTimersByTimeAsync(60);
    const error = await promise;

    expect(error).toBeInstanceOf(CodexAppServerError);
    expect((error as CodexAppServerError).reason).toBe("timeout");
    expect(killSpy).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });
});
