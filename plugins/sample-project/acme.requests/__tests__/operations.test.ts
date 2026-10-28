import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationManager, type OperationManager } from "@daintreehq/plugin-sdk/operations";
import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import type { PluginDatabase } from "@daintreehq/plugin-sdk";
import { syntheticReportKind } from "../src/provider";
import { createStoreOpener } from "../src/store";

const dirs: string[] = [];
const managers: OperationManager[] = [];
const databases: PluginDatabase[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(databases.splice(0).map((db) => db.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function reach(manager: OperationManager, id: string, state: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const op = await manager.get(id);
    if (op?.state === state) return op;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${state}; last seen ${JSON.stringify(op)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * One worker's worth of the report pipeline over a database directory, so a
 * second call with the same directory is the same project after a restart.
 */
function boot(dir: string, clock: { now: number }) {
  const host = createMockHost({
    pluginId: `project__${"c".repeat(64)}__acme.requests`,
    projectRoot: "/work/request-desk",
    databases: { directory: dir, declared: ["requests", "operations"] },
  });
  const openStore = createStoreOpener(host, (store) => databases.push(store.db));
  const written: string[] = [];
  const kind = syntheticReportKind({
    openStore,
    workspace: async () => "Demo workspace",
    writeReport: async (reportId) => {
      written.push(reportId);
      return `/work/reports/${reportId}.svg`;
    },
    now: () => clock.now,
    buildMs: 60_000,
    pollIntervalMs: 5,
  });
  const manager = createOperationManager(host, {
    database: "operations",
    retryActionId: `${host.pluginInfo.manifestId}.resume-report`,
    kinds: { report: kind },
    random: () => 0,
  });
  managers.push(manager);
  return { host, manager, kind, openStore, written };
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "request-desk-ops-"));
  dirs.push(dir);
  return dir;
}

describe("the report operation", () => {
  it("survives the worker stopping mid-build and finishes on the next start", async () => {
    const dir = tempDir();
    const clock = { now: Date.now() };
    const first = boot(dir, clock);
    const op = await first.manager.submit(
      "report",
      { requestedBy: "view" },
      { idempotencyKey: "k1" }
    );
    await reach(first.manager, op.id, "running");

    // The worker goes away: its task is interrupted, which is not a cancel.
    first.host.simulateTaskInterrupt(first.host.startedTasks[0]!.id);
    await first.manager.dispose();

    // The provider finishes while nobody is watching.
    clock.now += 61_000;
    const second = boot(dir, clock);
    await second.manager.start();
    await reach(second.manager, op.id, "succeeded");
    const done = await second.manager.get<{ reportId: string; requestCount: number }>(op.id);
    expect(done?.result?.requestCount).toBe(3);
    expect(second.written).toEqual([done!.result!.reportId]);
    expect(first.written).toEqual([]);
  });

  it("never starts a second provider job for the same idempotency key", async () => {
    const dir = tempDir();
    const { manager, openStore } = boot(dir, { now: Date.now() });
    const a = await manager.submit("report", { requestedBy: "agent" }, { idempotencyKey: "same" });
    const b = await manager.submit("report", { requestedBy: "agent" }, { idempotencyKey: "same" });
    expect(b.id).toBe(a.id);
    await reach(manager, a.id, "running");
    const store = await openStore();
    expect(await store.db.get("SELECT count(*) AS n FROM provider_jobs")).toEqual({ n: 1 });
  });

  it("finds a job a lost submit made, by its idempotency key", async () => {
    const dir = tempDir();
    const { kind } = boot(dir, { now: Date.now() });
    const signal = new AbortController().signal;
    const ctx = { operationId: "op-1", idempotencyKey: "lost", signal };
    // The submit reached the provider, but its answer never came back.
    const { providerId } = await kind.provider.submit({ requestedBy: "view" }, ctx);
    expect(await kind.provider.reconcile!({ requestedBy: "view" }, ctx)).toEqual({
      status: "found",
      providerId,
    });
    expect(
      await kind.provider.reconcile!({ requestedBy: "view" }, { ...ctx, idempotencyKey: "never" })
    ).toEqual({ status: "not-found" });
  });

  it("cancels a job still building, and reports one already built as built", async () => {
    const dir = tempDir();
    const clock = { now: Date.now() };
    const { kind } = boot(dir, clock);
    const signal = new AbortController().signal;
    const building = await kind.provider.submit(
      { requestedBy: "view" },
      { operationId: "a", idempotencyKey: "a", signal }
    );
    const ref = { providerId: building.providerId, checkpoint: null };
    const ctx = { operationId: "a", idempotencyKey: "a", signal };
    expect(await kind.provider.cancel!(ref, ctx)).toBe("cancelled");
    expect(await kind.provider.poll(ref, ctx)).toEqual({ status: "cancelled" });

    const built = await kind.provider.submit(
      { requestedBy: "view" },
      { operationId: "b", idempotencyKey: "b", signal }
    );
    const builtRef = { providerId: built.providerId, checkpoint: null };
    const bctx = { operationId: "b", idempotencyKey: "b", signal };
    clock.now += 61_000;
    expect((await kind.provider.poll(builtRef, bctx)).status).toBe("succeeded");
    expect(await kind.provider.cancel!(builtRef, bctx)).toBe("requested");
  });
});
