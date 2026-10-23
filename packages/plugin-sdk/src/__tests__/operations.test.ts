import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOperationManager,
  OperationConflictError,
  OperationError,
  type OperationKind,
  type OperationManager,
  type OperationManagerOptions,
} from "../operations.js";
import { createMockHost } from "../testing.js";

const SECRET = "sk-live-do-not-store-0123456789";

interface Job {
  key: string;
  input: { n: number };
  polls: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
}

/**
 * A synthetic remote provider: jobs keyed by idempotency key, finishing after
 * a set number of polls. The tests reach into it to stall, fail or cancel.
 */
function createSyntheticProvider(options: { pollsToFinish?: number } = {}) {
  const jobs = new Map<string, Job>();
  const calls = { submit: 0, poll: 0, reconcile: 0, cancel: 0 };
  const control = {
    /** The next submit records the job, then never answers: a crash mid-call. */
    hangAfterAccept: false,
    /** The next submit records the job, then fails as a dropped connection would. */
    throwAfterAccept: false,
    /** The next N polls answer with a status no provider should send. */
    badPolls: 0,
    /** The next N polls throw an error carrying a secret. */
    failPolls: 0,
    rejectSubmit: false,
    cancelAnswer: "cancelled" as "cancelled" | "requested" | "unsupported",
    pollsToFinish: options.pollsToFinish ?? 2,
  };
  const kind: OperationKind<{ n: number }, { doubled: number }> = {
    title: (input) => `Doubling ${input.n}`,
    pollIntervalMs: 5,
    callTimeoutMs: 1_000,
    retry: { initialIntervalMs: 1, maximumIntervalMs: 2, maximumAttempts: 3 },
    provider: {
      async submit(input, ctx) {
        calls.submit++;
        if (control.rejectSubmit) {
          throw new OperationError("INVALID_INPUT", "The provider refused the input", {
            retryable: false,
          });
        }
        const existing = jobs.get(ctx.idempotencyKey);
        if (!existing) {
          jobs.set(ctx.idempotencyKey, {
            key: ctx.idempotencyKey,
            input,
            polls: 0,
            status: "running",
          });
        }
        if (control.throwAfterAccept) {
          control.throwAfterAccept = false;
          throw new Error("socket hang up");
        }
        if (control.hangAfterAccept) {
          control.hangAfterAccept = false;
          await new Promise(() => {});
        }
        return { providerId: `job-${ctx.idempotencyKey}`, checkpoint: { polls: 0 } };
      },
      async poll(ref) {
        calls.poll++;
        if (control.badPolls > 0) {
          control.badPolls--;
          return { status: "weird" } as never;
        }
        if (control.failPolls > 0) {
          control.failPolls--;
          throw new Error(`upstream 503 for token ${SECRET}`);
        }
        const job = jobs.get(ref.providerId.slice("job-".length));
        if (!job) return { status: "failed", message: "Unknown job", code: "NOT_FOUND" };
        if (job.status === "cancelled") return { status: "cancelled" };
        job.polls++;
        if (job.polls >= control.pollsToFinish) {
          job.status = "succeeded";
          return { status: "succeeded", result: { doubled: job.input.n * 2 } };
        }
        return {
          status: "running",
          checkpoint: { polls: job.polls },
          progress: { fraction: job.polls / control.pollsToFinish, detail: `poll ${job.polls}` },
        };
      },
      async reconcile(_input, ctx) {
        calls.reconcile++;
        const job = jobs.get(ctx.idempotencyKey);
        return job ? { status: "found", providerId: `job-${job.key}` } : { status: "not-found" };
      },
      async cancel(ref) {
        calls.cancel++;
        const job = jobs.get(ref.providerId.slice("job-".length));
        if (job && control.cancelAnswer === "cancelled") job.status = "cancelled";
        return control.cancelAnswer;
      },
    },
  };
  return { kind, jobs, calls, control };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const dirs: string[] = [];
const managers: OperationManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  provider = createSyntheticProvider(),
  overrides: Partial<OperationManagerOptions> = {},
  dir = mkdtempSync(path.join(tmpdir(), "daintree-ops-"))
) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const host = createMockHost({ databases: { directory: dir, declared: ["operations"] } });
  const manager = createOperationManager(host, {
    database: "operations",
    retryActionId: "test.mock.resumeOperation",
    kinds: { double: provider.kind },
    random: () => 0,
    ...overrides,
  });
  managers.push(manager);
  return { host, manager, provider, dir };
}

describe("createOperationManager", () => {
  it("journals before acknowledging, then drives the operation to its result through a task", async () => {
    const { manager, host, dir } = setup();
    const op = await manager.submit("double", { n: 21 }, { projectId: "proj-a" });
    expect(op.state).toBe("pending");

    // Committed: another connection to the file sees it at once.
    const reader = await createMockHost({ databases: { directory: dir } }).db.open("operations", {
      readonly: true,
    });
    expect(await reader.get("SELECT project_id FROM operations WHERE id = ?", [op.id])).toEqual({
      project_id: "proj-a",
    });
    await reader.close();

    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
    const done = await manager.get<{ doubled: number }>(op.id);
    expect(done?.result).toEqual({ doubled: 42 });
    expect(done?.providerId).toMatch(/^job-/);

    const task = host.startedTasks[0]!;
    expect(task.options.title).toBe("Doubling 21");
    expect(task.options.retry.args).toEqual({ operationId: op.id });
    expect(task.reports.some((r) => r.detail === "poll 1")).toBe(true);
    await until(() => task.state === "succeeded", "task finished");
  });

  it("returns the existing operation for a repeated key and refuses one reused for a different request", async () => {
    const { manager, provider } = setup();
    const first = await manager.submit("double", { n: 1 }, { idempotencyKey: "k1" });
    const again = await manager.submit("double", { n: 1 }, { idempotencyKey: "k1" });
    expect(again.id).toBe(first.id);
    await expect(
      manager.submit("double", { n: 2 }, { idempotencyKey: "k1" })
    ).rejects.toBeInstanceOf(OperationConflictError);
    await until(async () => (await manager.get(first.id))?.state === "succeeded", "success");
    // Even once finished, the same request answers with the same operation.
    expect((await manager.submit("double", { n: 1 }, { idempotencyKey: "k1" })).id).toBe(first.id);
    expect(provider.calls.submit).toBe(1);
  });

  it("reconciles a submit cut off by a restart instead of sending it again", async () => {
    const provider = createSyntheticProvider();
    provider.control.hangAfterAccept = true;
    const first = setup(provider);
    const op = await first.manager.submit("double", { n: 5 }, { idempotencyKey: "restart" });
    await until(() => provider.jobs.has("restart"), "the provider accepting");
    expect((await first.manager.get(op.id))?.state).toBe("submitting");
    await first.manager.dispose();

    const second = setup(provider, {}, first.dir);
    await second.manager.start();
    await until(async () => (await second.manager.get(op.id))?.state === "succeeded", "success");
    expect(provider.calls.reconcile).toBe(1);
    expect(provider.calls.submit).toBe(1);
    expect((await second.manager.get<{ doubled: number }>(op.id))?.result).toEqual({ doubled: 10 });
  });

  it("records the user's Cancel and ends cancelled only when the provider confirms", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 1_000 });
    const { manager, host } = setup(provider);
    const op = await manager.submit("double", { n: 3 });
    await until(async () => (await manager.get(op.id))?.state === "running", "running");
    host.simulateTaskCancel(host.startedTasks[0]!.id);
    await until(async () => (await manager.get(op.id))?.state === "cancelled", "cancelled");
    expect(provider.calls.cancel).toBe(1);
    expect((await manager.get(op.id))?.cancelRequested).toBe(true);
    await until(() => host.startedTasks[0]!.state === "cancelled", "task cancelled");
  });

  it("keeps tracking when the provider can't cancel, and reports how it really ended", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 30 });
    provider.control.cancelAnswer = "unsupported";
    const { manager } = setup(provider);
    const op = await manager.submit("double", { n: 4 });
    await until(async () => (await manager.get(op.id))?.state === "running", "running");
    await manager.cancel(op.id);
    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
    const done = await manager.get(op.id);
    expect(done?.cancelRequested).toBe(true);
    expect(done?.result).toEqual({ doubled: 8 });
  });

  it("cancels an operation never sent without calling the provider", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 1_000 });
    const { manager } = setup(provider, { concurrency: 1 });
    const busy = await manager.submit("double", { n: 1 });
    await until(async () => (await manager.get(busy.id))?.state === "running", "first running");
    const queued = await manager.submit("double", { n: 2 });
    // At once, though the only slot is still busy.
    expect((await manager.cancel(queued.id))?.state).toBe("cancelled");
    expect(provider.calls.submit).toBe(1);
  });

  it("treats an interruption as the plugin stopping, not a cancel, and resumes on retry", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 20 });
    const { manager, host } = setup(provider);
    const op = await manager.submit("double", { n: 6 });
    await until(async () => (await manager.get(op.id))?.state === "running", "running");
    host.simulateTaskInterrupt(host.startedTasks[0]!.id);
    // Let a poll already in flight land, then nothing more may happen.
    await new Promise((r) => setTimeout(r, 50));
    const pollsAfterStop = provider.calls.poll;
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.calls.poll).toBe(pollsAfterStop);
    const stopped = await manager.get(op.id);
    expect(stopped?.state).toBe("running");
    expect(stopped?.cancelRequested).toBe(false);
    expect(host.startedTasks).toHaveLength(1);

    await manager.retry(op.id);
    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
    expect(host.startedTasks).toHaveLength(2);
  });

  it("backs off through transient failures without storing the provider's error text", async () => {
    const provider = createSyntheticProvider();
    provider.control.failPolls = 2;
    const { manager, dir } = setup(provider);
    const op = await manager.submit("double", { n: 7 });
    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
    expect((await manager.get(op.id))?.attempt).toBe(0);
    expect(readFileSync(path.join(dir, "operations.db")).includes(SECRET)).toBe(false);
  });

  it("abandons after the retry budget, with a generic error and the outcome left unknown", async () => {
    const provider = createSyntheticProvider();
    provider.control.failPolls = 100;
    const { manager, host, dir } = setup(provider);
    const op = await manager.submit("double", { n: 8 });
    await until(async () => (await manager.get(op.id))?.state === "abandoned", "abandoned");
    const done = await manager.get(op.id);
    expect(done?.error?.code).toBe("PROVIDER_ERROR");
    expect(done?.error?.message).toMatch(/outcome is unknown/);
    expect(JSON.stringify(done)).not.toContain(SECRET);
    await manager.dispose();
    expect(readFileSync(path.join(dir, "operations.db")).includes(SECRET)).toBe(false);
    const task = host.startedTasks[0]!;
    expect(task.state).toBe("failed");
    expect(JSON.stringify(task.result)).not.toContain(SECRET);

    // Retry resumes the same provider operation rather than starting another.
    provider.control.failPolls = 0;
    const resumed = setup(provider, {}, dir).manager;
    await resumed.retry(op.id);
    await until(async () => (await resumed.get(op.id))?.state === "succeeded", "success");
    expect(provider.calls.submit).toBe(1);
  });

  it("fails a submit the provider refuses outright", async () => {
    const provider = createSyntheticProvider();
    provider.control.rejectSubmit = true;
    const { manager } = setup(provider);
    const op = await manager.submit("double", { n: 9 });
    await until(async () => (await manager.get(op.id))?.state === "failed", "failed");
    expect((await manager.get(op.id))?.error).toEqual({
      code: "INVALID_INPUT",
      message: "The provider refused the input",
    });
  });

  it("abandons an operation still running at its deadline", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 1_000 });
    provider.kind.deadlineMs = 500;
    const { manager } = setup(provider);
    const op = await manager.submit("double", { n: 10 });
    await until(async () => (await manager.get(op.id))?.state === "abandoned", "abandoned");
    expect((await manager.get(op.id))?.error?.code).toBe("DEADLINE_EXCEEDED");
  });

  it("lists by project, newest first, and prunes finished operations past the retention count", async () => {
    // A clock that always moves, so creation and completion order are distinct.
    let clock = Date.now();
    const { manager } = setup(createSyntheticProvider(), {
      concurrency: 1,
      retention: { maxCount: 2 },
      now: () => (clock = Math.max(clock + 1, Date.now())),
    });
    const a = await manager.submit("double", { n: 1 }, { projectId: "a" });
    const b = await manager.submit("double", { n: 2 }, { projectId: "b" });
    const c = await manager.submit("double", { n: 3 }, { projectId: "a" });
    expect((await manager.list({ projectId: "a" })).map((op) => op.id)).toEqual([c.id, a.id]);
    expect((await manager.list({ limit: 1 })).map((op) => op.id)).toEqual([c.id]);
    expect(await manager.list({ states: [] })).toEqual([]);
    // Pruned as each finishes: the oldest-finished goes once a third is done.
    await until(async () => (await manager.get(c.id))?.state === "succeeded", "all done");
    await until(async () => (await manager.get(a.id)) === undefined, "oldest pruned");
    expect((await manager.list()).map((op) => op.id)).toEqual([c.id, b.id]);
  });

  it("sends an uncertain submit again under the same key when the provider can't be asked", async () => {
    const provider = createSyntheticProvider();
    delete provider.kind.provider.reconcile;
    provider.control.throwAfterAccept = true;
    const { manager } = setup(provider);
    const op = await manager.submit("double", { n: 11 });
    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
    expect(provider.calls.submit).toBe(2);
    expect(provider.jobs.size).toBe(1);
  });

  it("abandons at once while a submit is in flight, and the late answer changes nothing", async () => {
    const provider = createSyntheticProvider();
    provider.control.hangAfterAccept = true;
    const { manager, host } = setup(provider);
    const op = await manager.submit("double", { n: 12 });
    await until(async () => (await manager.get(op.id))?.state === "submitting", "submitting");
    expect((await manager.abandon(op.id))?.state).toBe("abandoned");
    await manager.dispose();
    expect(host.startedTasks[0]!.state).not.toBe("working");
  });

  it("retries a provider answer it can't read instead of inventing an outcome", async () => {
    const provider = createSyntheticProvider();
    provider.control.badPolls = 1;
    const { manager } = setup(provider);
    const op = await manager.submit("double", { n: 13 });
    await until(async () => (await manager.get(op.id))?.state === "succeeded", "success");
  });

  it("waits for its retry timer when the host has no task slot, rather than spinning", async () => {
    const provider = createSyntheticProvider();
    const dir = mkdtempSync(path.join(tmpdir(), "daintree-ops-"));
    dirs.push(dir);
    const mock = createMockHost({ databases: { directory: dir } });
    let starts = 0;
    const manager = createOperationManager(
      {
        db: mock.db,
        tasks: {
          start: async () => {
            starts++;
            throw new Error("already has 16 unfinished tasks");
          },
        },
      },
      {
        database: "operations",
        retryActionId: "test.mock.resume",
        kinds: { double: provider.kind },
      }
    );
    managers.push(manager);
    const op = await manager.submit("double", { n: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(starts).toBe(1);
    expect((await manager.get(op.id))?.state).toBe("pending");
  });

  it("can start again after the journal failed to open", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daintree-ops-"));
    dirs.push(dir);
    const mock = createMockHost({ databases: { directory: dir } });
    let opens = 0;
    const manager = createOperationManager(
      {
        db: {
          open: (id, openOptions) => {
            opens++;
            return opens === 1 ? Promise.reject(new Error("busy")) : mock.db.open(id, openOptions);
          },
        },
        tasks: mock.tasks,
      },
      {
        database: "operations",
        retryActionId: "test.mock.resume",
        kinds: { double: createSyntheticProvider().kind },
      }
    );
    managers.push(manager);
    await expect(manager.start()).rejects.toThrow("busy");
    await manager.start();
    expect(await manager.list()).toEqual([]);
  });

  it("holds a task only while it drives, so a busy plugin keeps its project awake", async () => {
    const provider = createSyntheticProvider({ pollsToFinish: 1_000 });
    const { manager, host } = setup(provider, { concurrency: 2 });
    await manager.submit("double", { n: 1 });
    await manager.submit("double", { n: 2 });
    await manager.submit("double", { n: 3 });
    await until(() => host.startedTasks.length === 2, "two tasks");
    await new Promise((r) => setTimeout(r, 20));
    expect(host.startedTasks.filter((t) => t.state === "working")).toHaveLength(2);
    // A task the user cancelled is still live until finished; dispose ends it too.
    provider.control.cancelAnswer = "unsupported";
    host.simulateTaskCancel(host.startedTasks[0]!.id);
    await manager.dispose();
    expect(host.startedTasks.every((t) => t.state !== "working" && t.state !== "cancelling")).toBe(
      true
    );
  });
});
