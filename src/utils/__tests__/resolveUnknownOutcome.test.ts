import { describe, expect, it, vi } from "vitest";
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
      const result: { value?: OperationOutcome } = {};
      void pending.then((value) => (result.value = value)).catch(() => {});

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer({ status: "running", progress: null });

      try {
        await vi.waitFor(() => expect(result.value).toEqual(succeeded), { timeout: 500 });
        expect(client.getStatus).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
      }
    });

    it("wins over a stale unknown reply", async () => {
      const { client, emit, answer } = pendingReadClient();
      const pending = resolveUnknownOutcome("op-1", { waitForConnected: async () => {}, client });

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer({ status: "unknown" });

      await expect(pending).resolves.toEqual(succeeded);
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
      const result: { value?: OperationOutcome } = {};
      void pending.then((value) => (result.value = value)).catch(() => {});

      await vi.waitFor(() => expect(client.getStatus).toHaveBeenCalledOnce());
      emit(settledEvent("op-1", succeeded));
      answer(appError("HOST_DISCONNECTED"));

      try {
        await vi.waitFor(() => expect(result.value).toEqual(succeeded), { timeout: 500 });
        expect(waitForConnected).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
      }
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
