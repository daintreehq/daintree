import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OperationRegistry,
  OPERATION_RETENTION_MS,
  OPERATION_MAX_ALIASES,
  OPERATION_MAX_RUNNING,
  normalizeOperationId,
  untrackedOperationHandle,
} from "../OperationRegistry.js";
import type { OperationsEvent } from "../../../../shared/types/ipc/operations.js";

let now: number;
let events: Array<{ projectId: string | null; event: OperationsEvent }>;

function makeRegistry(overrides: ConstructorParameters<typeof OperationRegistry>[0] = {}) {
  return new OperationRegistry({
    now: () => now,
    emit: (projectId, event) => events.push({ projectId, event }),
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  now = 1_000_000;
  events = [];
});

describe("OperationRegistry", () => {
  it("returns the first record for a second start with the same opId", () => {
    const registry = makeRegistry();
    const first = registry.start({ opId: "op-1", kind: "git-push", projectId: "p" });
    const second = registry.start({ opId: "op-1", kind: "git-push", projectId: "p" });

    expect(first.handle).not.toBeNull();
    expect(second.handle).toBeNull();
    expect(second.record).toBe(first.record);
  });

  it("refuses an opId already used by a different kind of operation", () => {
    const registry = makeRegistry();
    registry.start({ opId: "op-1", kind: "git-push", projectId: "p" });
    expect(() => registry.start({ opId: "op-1", kind: "git-clone", projectId: "p" })).toThrow(
      /another operation/
    );
  });

  it("runs the work once for every caller that joins it", async () => {
    const registry = makeRegistry();
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);

    const a = registry.run({ opId: "op-1", kind: "git-clone", projectId: null }, work);
    const b = registry.run({ opId: "op-1", kind: "git-clone", projectId: null }, work);
    gate.resolve("done");

    await expect(a).resolves.toBe("done");
    await expect(b).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);

    // A retry after settlement is answered from the record.
    await expect(
      registry.run({ opId: "op-1", kind: "git-clone", projectId: null }, work)
    ).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("joins a running operation by dedupKey and answers for the joiner's id", async () => {
    const registry = makeRegistry();
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);

    const a = registry.run(
      { opId: "op-a", kind: "git-clone", projectId: null, dedupKey: "k" },
      work
    );
    const b = registry.run(
      { opId: "op-b", kind: "git-clone", projectId: null, dedupKey: "k" },
      work
    );
    expect(registry.status("op-b").status).toBe("running");
    gate.resolve("cloned");
    await Promise.all([a, b]);

    expect(work).toHaveBeenCalledTimes(1);
    expect(registry.status("op-b")).toMatchObject({ status: "succeeded", result: "cloned" });

    // The key frees on settlement: a new clone of the same target runs.
    await registry.run(
      { opId: "op-c", kind: "git-clone", projectId: null, dedupKey: "k" },
      async () => "again"
    );
    expect(registry.status("op-c")).toMatchObject({ status: "succeeded", result: "again" });
  });

  it("mints an id when the caller sends none", () => {
    const registry = makeRegistry();
    const { record } = registry.start({ kind: "copytree", projectId: "p" });
    expect(record.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registry.status(record.opId).status).toBe("running");
  });

  it("pushes progress to the operation's project, stamped with its opId", () => {
    const registry = makeRegistry({ progressIntervalMs: 100 });
    const { handle } = registry.start({ opId: "op-1", kind: "git-push", projectId: "p" });

    handle!.progress({ fraction: 0.2, stage: "writing", message: null });
    now += 10;
    handle!.progress({ fraction: 0.3, stage: "writing", message: null });
    now += 10;
    handle!.progress({ fraction: 1.7, stage: "done", message: "ok" });

    // The paced middle update is dropped from the push but kept on the record.
    expect(events.map((e) => e.event)).toEqual([
      {
        type: "progress",
        progress: {
          opId: "op-1",
          kind: "git-push",
          fraction: 0.2,
          stage: "writing",
          message: null,
          at: 1_000_000,
        },
      },
      {
        type: "progress",
        progress: expect.objectContaining({ opId: "op-1", fraction: 1, stage: "done" }),
      },
    ]);
    expect(events.every((e) => e.projectId === "p")).toBe(true);
    expect(registry.status("op-1")).toMatchObject({
      status: "running",
      progress: { fraction: 1, stage: "done" },
    });
  });

  it("records failures with their code, and cancellations as cancelled", async () => {
    const registry = makeRegistry();
    const failure = Object.assign(new Error("rejected"), { reason: "push-rejected-outdated" });
    await expect(
      registry.run({ opId: "op-f", kind: "git-push", projectId: "p" }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(registry.status("op-f")).toEqual({
      status: "failed",
      error: { code: "push-rejected-outdated", message: "rejected" },
      settledAt: now,
    });

    const cancelled = Object.assign(new Error("Clone cancelled"), { code: "CANCELLED" });
    await expect(
      registry.run({ opId: "op-c", kind: "git-clone", projectId: null }, async () => {
        throw cancelled;
      })
    ).rejects.toBe(cancelled);
    expect(registry.status("op-c")).toEqual({ status: "cancelled", settledAt: now });

    expect(events.at(-1)).toEqual({
      projectId: null,
      event: {
        type: "settled",
        record: expect.objectContaining({
          opId: "op-c",
          outcome: { status: "cancelled", settledAt: now },
        }),
      },
    });
  });

  it("treats an in-band error result as a failure and keeps only the recorded summary", async () => {
    const registry = makeRegistry();
    await registry.run(
      { opId: "op-1", kind: "copytree", projectId: "p" },
      async () => ({ content: "", error: "Worktree not found" }),
      { failureOf: (r) => r.error ?? null }
    );
    expect(registry.status("op-1")).toMatchObject({
      status: "failed",
      error: { code: null, message: "Worktree not found" },
    });

    await registry.run(
      { opId: "op-2", kind: "copytree", projectId: "p" },
      async () => ({ content: "huge", fileCount: 3 }),
      { recordResult: (r) => ({ fileCount: r.fileCount }) }
    );
    expect(registry.status("op-2")).toMatchObject({
      status: "succeeded",
      result: { fileCount: 3 },
    });
  });

  it("reports unknown for an id it never saw, and after the retention window", async () => {
    const registry = makeRegistry();
    expect(registry.status("never")).toEqual({ status: "unknown" });

    await registry.run({ opId: "op-1", kind: "git-push", projectId: "p" }, async () => undefined);
    expect(registry.status("op-1")).toMatchObject({ status: "succeeded", result: null });

    now += OPERATION_RETENTION_MS - 1;
    expect(registry.status("op-1").status).toBe("succeeded");
    now += 2;
    expect(registry.status("op-1")).toEqual({ status: "unknown" });
    expect(registry.list()).toEqual([]);
  });

  it("drops the oldest settled records beyond the count cap, never a running one", async () => {
    const registry = makeRegistry({ maxSettled: 2 });
    registry.start({ opId: "running", kind: "git-clone", projectId: null });
    for (const id of ["a", "b", "c"]) {
      now += 1;
      await registry.run({ opId: id, kind: "git-push", projectId: null }, async () => id);
    }
    expect(registry.status("a")).toEqual({ status: "unknown" });
    expect(registry.status("b").status).toBe("succeeded");
    expect(registry.status("c").status).toBe("succeeded");
    expect(registry.status("running").status).toBe("running");
  });

  it("cancels through the signal and registered listeners, only while running", async () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    const promise = registry.run({ opId: "op-1", kind: "copytree", projectId: "p" }, (op) => {
      op.onCancel(listener);
      return new Promise((_resolve, reject) => {
        op.signal.addEventListener("abort", () => reject(new Error("stopped")));
      });
    });

    expect(registry.cancel("missing")).toBe(false);
    expect(registry.cancel("op-1")).toBe(true);
    await expect(promise).rejects.toThrow("stopped");
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.status("op-1").status).toBe("cancelled");
    expect(registry.cancel("op-1")).toBe(false);
  });

  it("lists records for one project", async () => {
    const registry = makeRegistry();
    registry.start({ opId: "a", kind: "git-push", projectId: "p1" });
    registry.start({ opId: "b", kind: "git-push", projectId: "p2" });
    expect(registry.list("p1").map((r) => r.opId)).toEqual(["a"]);
    expect(registry.list().map((r) => r.opId)).toEqual(["a", "b"]);
  });

  it("keeps working when event delivery throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = makeRegistry({
      emit: () => {
        throw new Error("link closed");
      },
    });
    await expect(
      registry.run({ opId: "op-1", kind: "git-push", projectId: "p" }, async (op) => {
        op.progress({ fraction: 0.5, stage: "writing", message: null });
        return "ok";
      })
    ).resolves.toBe("ok");
    expect(registry.status("op-1").status).toBe("succeeded");
    warn.mockRestore();
  });
});

describe("OperationRegistry guards", () => {
  it("refuses an id reused for another request or another project", () => {
    const registry = makeRegistry();
    registry.start({ opId: "op-1", kind: "copytree", scope: "copytree:generate", projectId: "p" });
    expect(() =>
      registry.start({ opId: "op-1", kind: "copytree", scope: "copytree:inject", projectId: "p" })
    ).toThrow(/another operation/);
    expect(() =>
      registry.start({ opId: "op-1", kind: "copytree", scope: "copytree:generate", projectId: "q" })
    ).toThrow(/another operation/);
  });

  it("won't claim to cancel work that registered no way to stop", () => {
    const registry = makeRegistry();
    registry.start({ opId: "op-1", kind: "git-push", projectId: "p" });
    expect(registry.cancel("op-1")).toBe(false);
    expect(registry.status("op-1").status).toBe("running");
  });

  it("settles an in-band cancellation as cancelled", async () => {
    const registry = makeRegistry();
    await registry.run(
      { opId: "op-1", kind: "copytree", projectId: "p" },
      async () => ({ error: "Injection cancelled" }),
      { failureOf: (r) => r.error, cancelledBy: (r) => r.error === "Injection cancelled" }
    );
    expect(registry.status("op-1").status).toBe("cancelled");
  });

  it("scrubs credentials out of a published failure", async () => {
    const registry = makeRegistry();
    await expect(
      registry.run({ opId: "op-1", kind: "git-push", projectId: "p" }, async () => {
        throw new Error(
          "fatal: unable to access 'https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r'"
        );
      })
    ).rejects.toThrow();
    const outcome = registry.status("op-1");
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("tells a joiner its own id settled, and resolves the alias to the shared work", async () => {
    const registry = makeRegistry();
    const gate = deferred<string>();
    const a = registry.run(
      { opId: "op-a", kind: "git-clone", projectId: null, dedupKey: "k" },
      () => gate.promise
    );
    const b = registry.run(
      { opId: "op-b", kind: "git-clone", projectId: null, dedupKey: "k" },
      () => gate.promise
    );
    expect(registry.canonicalId("op-b")).toBe("op-a");
    gate.resolve("ok");
    await Promise.all([a, b]);

    const settledIds = events
      .map((e) => e.event)
      .filter((e) => e.type === "settled")
      .map((e) => (e.type === "settled" ? e.record.opId : null));
    expect(settledIds).toEqual(["op-a", "op-b"]);
  });
});

describe("OperationRegistry joins and admission", () => {
  const clone = (opId: string, overrides: Record<string, unknown> = {}) => ({
    opId,
    kind: "git-clone" as const,
    projectId: "p",
    dedupKey: "k",
    fingerprint: '{"shallow":false}',
    ...overrides,
  });

  it("refuses to join running work whose request differs", () => {
    const registry = makeRegistry();
    registry.start(clone("op-a"));

    expect(() => registry.start(clone("op-b", { fingerprint: '{"shallow":true}' }))).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
    expect(() => registry.start(clone("op-c", { projectId: "other" }))).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
    // A refused joiner leaves nothing behind that answers for its id.
    expect(registry.status("op-b")).toEqual({ status: "unknown" });
    expect(registry.status("op-c")).toEqual({ status: "unknown" });
  });

  it("refuses a retry by opId whose request differs", () => {
    const registry = makeRegistry();
    registry.start(clone("op-a"));
    expect(() => registry.start(clone("op-a", { fingerprint: '{"shallow":true}' }))).toThrow(
      /another operation/
    );
  });

  it("gives every accepted joiner a resolvable id, and refuses one past the cap", () => {
    const registry = makeRegistry();
    registry.start(clone("op-first"));
    for (let i = 0; i < OPERATION_MAX_ALIASES; i++) {
      expect(registry.start(clone(`op-join-${i}`)).handle).toBeNull();
    }
    for (let i = 0; i < OPERATION_MAX_ALIASES; i++) {
      expect(registry.canonicalId(`op-join-${i}`)).toBe("op-first");
    }

    expect(() => registry.start(clone("op-overflow"))).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" })
    );
    expect(registry.status("op-overflow")).toEqual({ status: "unknown" });
    // An id that already joined is still answered from its record.
    expect(registry.start(clone("op-join-0")).record.opId).toBe("op-first");
  });

  it("admits running work up to the cap and refuses the next", () => {
    const registry = makeRegistry();
    for (let i = 0; i < OPERATION_MAX_RUNNING; i++) {
      registry.start({ opId: `op-${i}`, kind: "git-push", projectId: "p" });
    }
    expect(() => registry.start({ opId: "op-over", kind: "git-push", projectId: "p" })).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" })
    );
    // A retry of admitted work is not new work.
    expect(registry.start({ opId: "op-0", kind: "git-push", projectId: "p" }).handle).toBeNull();

    registry.settle("op-0", { status: "succeeded", result: null });
    expect(
      registry.start({ opId: "op-over", kind: "git-push", projectId: "p" }).handle
    ).not.toBeNull();
  });

  it("hands out an untracked handle that records and publishes nothing", () => {
    const handle = untrackedOperationHandle();
    handle.progress({ fraction: 0.5, stage: "x", message: null });
    handle.onCancel(() => {});
    expect(handle.tracked).toBe(false);
    expect(handle.signal.aborted).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("normalizeOperationId", () => {
  it("accepts well-formed ids and rejects everything else", () => {
    expect(normalizeOperationId("0b5c6a1e-7f1d-4a55-9a51-2b1f0d6f3c11")).toBe(
      "0b5c6a1e-7f1d-4a55-9a51-2b1f0d6f3c11"
    );
    expect(normalizeOperationId("")).toBeNull();
    expect(normalizeOperationId(42)).toBeNull();
    expect(normalizeOperationId("a/b")).toBeNull();
    expect(normalizeOperationId("x".repeat(129))).toBeNull();
  });
});
