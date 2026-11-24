import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationOutcome } from "@shared/types/remoteHosts";
import type { OperationsEvent } from "@shared/types/ipc/operations";
import { isUnknownOutcomeError, resolveUnknownOutcome } from "../resolveUnknownOutcome";

function appError(code: string) {
  return new Error(`[AppError|${code}] link down`);
}

function fakeClient(statuses: Array<OperationOutcome | Error>) {
  let listener: ((event: OperationsEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const client = {
    getStatus: vi.fn(async () => {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (next instanceof Error) throw next;
      return next;
    }),
    onEvent: vi.fn((callback: (event: OperationsEvent) => void) => {
      listener = callback;
      return unsubscribe;
    }),
  };
  return { client, unsubscribe, emit: (event: OperationsEvent) => listener?.(event) };
}

/** A client whose first status read stays pending until the test answers it. */
function pendingReadClient() {
  const { client, unsubscribe, emit } = fakeClient([{ status: "unknown" }]);
  let answer!: (reply: OperationOutcome | Error) => void;
  client.getStatus.mockImplementationOnce(
    () =>
      new Promise<OperationOutcome>((resolve, reject) => {
        answer = (reply) => (reply instanceof Error ? reject(reply) : resolve(reply));
      })
  );
  return { client, unsubscribe, emit, answer: (reply: OperationOutcome | Error) => answer(reply) };
}

const succeeded: OperationOutcome = {
  status: "succeeded",
  result: { clonedPath: "/x" },
  settledAt: 5,
};

/**
 * The promise's own result if it settles within the current task's microtasks,
 * otherwise a marker: the resolver must answer without waiting on any timer.
 */
function beforeNextTask<T>(pending: Promise<T>): Promise<T | "still pending"> {
  return Promise.race([
    pending,
    new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 0)),
  ]);
}

function settledEvent(opId: string, outcome: OperationOutcome): OperationsEvent {
  return {
    type: "settled",
    record: { opId, kind: "git-clone", projectId: null, startedAt: 1, outcome },
  };
}

describe("isUnknownOutcomeError", () => {
  it("recognises a dropped link and an unknown outcome, nothing else", () => {
    expect(isUnknownOutcomeError(appError("HOST_DISCONNECTED"))).toBe(true);
    expect(isUnknownOutcomeError(appError("OUTCOME_UNKNOWN"))).toBe(true);
    expect(isUnknownOutcomeError(appError("CANCELLED"))).toBe(false);
    expect(isUnknownOutcomeError(new Error("boom"))).toBe(false);
  });
});

describe("resolveUnknownOutcome", () => {
  it("waits for the link, then returns the Host's recorded outcome", async () => {
    const order: string[] = [];
    const { client, unsubscribe } = fakeClient([succeeded]);
    client.getStatus.mockImplementation(async () => {
      order.push("status");
      return succeeded;
    });
    const waitForConnected = vi.fn(async () => {
      order.push("connected");
    });

    await expect(resolveUnknownOutcome("op-1", { waitForConnected, client })).resolves.toEqual(
      succeeded
    );
    expect(order).toEqual(["connected", "status"]);
    expect(client.getStatus).toHaveBeenCalledWith("op-1");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns unknown as an answer when the Host has no record", async () => {
    const { client } = fakeClient([{ status: "unknown" }]);
    await expect(
      resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client })
    ).resolves.toEqual({ status: "unknown" });
  });

  it("waits out a second drop before asking again", async () => {
    const { client } = fakeClient([appError("HOST_DISCONNECTED"), succeeded]);
    const waitForConnected = vi.fn(async () => {});

    await expect(resolveUnknownOutcome("op-1", { waitForConnected, client })).resolves.toEqual(
      succeeded
    );
    expect(waitForConnected).toHaveBeenCalledTimes(2);
  });

  it("follows a running operation until its settled event arrives", async () => {
    const running: OperationOutcome = { status: "running", progress: null };
    const { client, emit } = fakeClient([running]);

    const pending = resolveUnknownOutcome("op-1", {
      waitForConnected: async () => {},
      client,
      pollIntervalMs: 60_000,
    });
    await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    emit({
      type: "settled",
      record: {
        opId: "op-1",
        kind: "git-clone",
        projectId: null,
        startedAt: 1,
        outcome: succeeded,
      },
    });

    await expect(pending).resolves.toEqual(succeeded);
  });

  describe("a settlement that arrives while a status read is pending", () => {
    it("wins over a stale running reply without waiting for the next poll", async () => {
      const { client, emit, answer } = pendingReadClient();
      const controller = new AbortController();
      const pending = resolveUnknownOutcome("op-1", {
        waitForConnected: async () => {},
        client,
        signal: controller.signal,
        pollIntervalMs: 60_000,
      });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer({ status: "running", progress: null });

      try {
        await expect(beforeNextTask(pending)).resolves.toEqual(succeeded);
        expect(client.getStatus).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
      }
    });

    it.each([
      ["succeeded", succeeded],
      [
        "failed",
        {
          status: "failed",
          error: { code: "E", message: "boom" },
          settledAt: 6,
        } as OperationOutcome,
      ],
      ["cancelled", { status: "cancelled", settledAt: 7 } as OperationOutcome],
    ])("wins over a stale unknown reply when it %s", async (_label, settlement) => {
      const { client, emit, answer } = pendingReadClient();
      const pending = resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", settlement));
      answer({ status: "unknown" });

      await expect(pending).resolves.toEqual(settlement);
    });

    it("wins over a drop during the read without waiting for the link", async () => {
      const { client, emit, answer, unsubscribe } = pendingReadClient();
      const controller = new AbortController();
      const waitForConnected = vi
        .fn<(signal?: AbortSignal) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(
          (signal) =>
            new Promise<void>((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new Error("aborted")))
            )
        );
      const pending = resolveUnknownOutcome("op-1", {
        waitForConnected,
        client,
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer(appError("HOST_DISCONNECTED"));

      try {
        await expect(beforeNextTask(pending)).resolves.toEqual(succeeded);
        expect(waitForConnected).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
      }
    });

    it("wins over an ordinary lookup error", async () => {
      const { client, emit, answer } = pendingReadClient();
      const pending = resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer(new Error("no handler"));

      await expect(pending).resolves.toEqual(succeeded);
    });

    it.each([
      ["a running reply", { status: "running", progress: null } as OperationOutcome],
      ["a dropped link", appError("HOST_DISCONNECTED")],
    ])("still loses to an abort that came with it, answered by %s", async (_label, reply) => {
      const { client, emit, answer } = pendingReadClient();
      const controller = new AbortController();
      const pending = resolveUnknownOutcome("op-1", {
        waitForConnected: async () => {},
        client,
        signal: controller.signal,
        pollIntervalMs: 60_000,
      });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      controller.abort();
      answer(reply);

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it.each([
      ["running", { status: "running", progress: null } as OperationOutcome],
      ["unknown", { status: "unknown" } as OperationOutcome],
    ])("ignores a settled event whose outcome is %s", async (_label, outcome) => {
      const { client, emit, answer } = pendingReadClient();
      const pending = resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      const failed: OperationOutcome = {
        status: "failed",
        error: { code: null, message: "clone failed" },
        settledAt: 6,
      };
      emit(settledEvent("op-1", outcome));
      answer(failed);

      await expect(pending).resolves.toEqual(failed);
    });

    it("ignores a settlement for another operation", async () => {
      const { client, emit, answer } = pendingReadClient();
      const pending = resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-2", succeeded));
      answer({ status: "unknown" });

      await expect(pending).resolves.toEqual({ status: "unknown" });
    });
  });

  it("hands back the running outcome once the settle timeout passes", async () => {
    const running: OperationOutcome = { status: "running", progress: null };
    const { client } = fakeClient([running]);

    await expect(
      resolveUnknownOutcome("op-1", {
        waitForConnected: async () => {},
        client,
        pollIntervalMs: 5,
        settleTimeoutMs: 20,
      })
    ).resolves.toEqual(running);
    expect(client.getStatus.mock.calls.length).toBeGreaterThan(1);
  });

  describe("after a long offline gap", () => {
    const running: OperationOutcome = { status: "running", progress: null };
    const SIX_MINUTES = 6 * 60_000;

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A link that stays down until the test brings it back after a gap, with
     * no status read made while it is down.
     */
    function heldLink(client: ReturnType<typeof fakeClient>["client"]) {
      let reconnect: (() => void) | null = null;
      const waitForConnected = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            reconnect = resolve;
          })
      );
      return {
        waitForConnected,
        reconnectAfter: async (gapMs: number) => {
          expect(reconnect).not.toBeNull();
          const readsBefore = client.getStatus.mock.calls.length;
          await vi.advanceTimersByTimeAsync(gapMs);
          expect(client.getStatus).toHaveBeenCalledTimes(readsBefore);
          const up = reconnect!;
          reconnect = null;
          up();
          await vi.advanceTimersByTimeAsync(0);
        },
      };
    }

    it("keeps following an operation still running when the link comes back after the window's length", async () => {
      const { client } = fakeClient([running, running, succeeded]);
      const link = heldLink(client);

      const pending = resolveUnknownOutcome("op-1", {
        waitForConnected: link.waitForConnected,
        client,
        pollIntervalMs: 2_000,
        settleTimeoutMs: 5 * 60_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getStatus).not.toHaveBeenCalled();
      await link.reconnectAfter(SIX_MINUTES);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(pending).resolves.toEqual(succeeded);
      expect(client.getStatus).toHaveBeenCalledTimes(3);
      expect(link.waitForConnected).toHaveBeenCalledOnce();
    });

    it("charges a poll wait that fires late after a sleep only its scheduled length", async () => {
      const { client } = fakeClient([running]);
      let result: OperationOutcome | undefined;
      // The first poll's timer fires six minutes late, as it would on a machine
      // that slept through it: every clock moves on by that much.
      const fakeSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
      const scheduled = globalThis.setTimeout;
      let slept = false;
      Object.defineProperty(globalThis, "setTimeout", {
        ...fakeSetTimeout,
        value: ((callback: () => void, ms?: number) => {
          const delayMs = (ms ?? 0) + (slept ? 0 : SIX_MINUTES);
          slept = true;
          return scheduled(callback, delayMs);
        }) as typeof setTimeout,
      });
      try {
        const pending = resolveUnknownOutcome("op-1", {
          waitForConnected: async () => {},
          client,
          pollIntervalMs: 2_000,
          settleTimeoutMs: 3_000,
        }).then((outcome) => {
          result = outcome;
        });
        await vi.advanceTimersByTimeAsync(SIX_MINUTES + 2_000);
        // The late wait cost 2s of the 3s window, so 1s is left to wait.
        expect(client.getStatus).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(client.getStatus).toHaveBeenCalledTimes(2);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(client.getStatus).toHaveBeenCalledTimes(3);
        expect(result).toEqual(running);
        await pending;
      } finally {
        // Back to the fake clock's own timer, so its uninstall puts the real one back.
        Object.defineProperty(globalThis, "setTimeout", fakeSetTimeout);
      }
    });

    it("keeps what is left of the window across later drops, without refilling it", async () => {
      const { client } = fakeClient([
        running,
        appError("HOST_DISCONNECTED"),
        running,
        appError("OUTCOME_UNKNOWN"),
        running,
        running,
      ]);
      const link = heldLink(client);
      let result: OperationOutcome | undefined;

      const pending = resolveUnknownOutcome("op-1", {
        waitForConnected: link.waitForConnected,
        client,
        pollIntervalMs: 2_000,
        settleTimeoutMs: 5_000,
      }).then((outcome) => {
        result = outcome;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getStatus).not.toHaveBeenCalled();
      await link.reconnectAfter(SIX_MINUTES);
      // 2s spent; the next read finds the link down.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.getStatus).toHaveBeenCalledTimes(2);
      await link.reconnectAfter(SIX_MINUTES);
      // 4s spent; down again.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.getStatus).toHaveBeenCalledTimes(4);
      await link.reconnectAfter(SIX_MINUTES);
      expect(client.getStatus).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(999);
      expect(client.getStatus).toHaveBeenCalledTimes(5);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getStatus).toHaveBeenCalledTimes(6);
      expect(result).toEqual(running);
      expect(link.waitForConnected).toHaveBeenCalledTimes(3);
      await pending;
    });
  });

  it("rethrows an error that isn't a dropped link", async () => {
    const { client } = fakeClient([new Error("no handler")]);
    await expect(
      resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client })
    ).rejects.toThrow("no handler");
  });

  it("stops when aborted", async () => {
    const running: OperationOutcome = { status: "running", progress: null };
    const { client } = fakeClient([running]);
    const controller = new AbortController();

    const pending = resolveUnknownOutcome("op-1", {
      waitForConnected: async () => {},
      client,
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });
    await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
