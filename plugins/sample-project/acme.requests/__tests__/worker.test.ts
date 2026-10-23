import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import { CHANNELS, EVENTS, type RequestRecord } from "../src/contracts";
import { activate } from "../src/index";
import { MIGRATIONS } from "../src/store";

const PROJECT_ID = "c".repeat(64);
const PLUGIN_ID = `project__${PROJECT_ID}__acme.requests`;
const PROJECT_ROOT = "/work/request-desk";

const dirs: string[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  // Disposal closes the journal asynchronously; let it finish before the
  // directory goes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function start(settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "request-desk-"));
  dirs.push(dir);
  const host = createMockHost({
    pluginId: PLUGIN_ID,
    projectRoot: PROJECT_ROOT,
    databases: {
      directory: dir,
      declared: ["requests", "operations"],
      schemaVersions: { requests: 3 },
    },
    settings: { local: settings },
    manifestSettings: [{ id: "providerWorkspace", type: "string", scope: "local" }],
  });
  disposers.push(await activate(host));
  const invoke = <T>(channel: string, args?: unknown): Promise<T> => {
    const record = host.registeredHandlers.find((entry) => entry.channel === channel);
    if (!record) throw new Error(`no handler for ${channel}`);
    return record.handler({} as never, args) as Promise<T>;
  };
  const tools = host.registeredMcpTools.find((entry) => entry.endpointId === "requests")!.tools;
  const callTool = <T>(name: string, args: Record<string, unknown>): Promise<T> =>
    tools[name]!.execute(args, {} as never, new AbortController().signal) as Promise<T>;
  const runAction = (id: string, args?: unknown) =>
    host.registeredActions.find((entry) => entry.descriptor.id === id)!.handler(args as never);
  return { host, invoke, callTool, runAction, tools };
}

describe("Request Desk worker", () => {
  it("serves the tools the manifest's endpoint promises, each within the host's roster rules", async () => {
    const { tools } = await start();
    expect(Object.keys(tools).sort()).toEqual([
      "add_request",
      "generate_report",
      "get_report",
      "list_requests",
      "update_request",
    ]);
    for (const tool of Object.values(tools)) {
      expect(Buffer.byteLength(tool.description)).toBeLessThanOrEqual(400);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("seeds the demo requests once, and a deleted one stays deleted", async () => {
    const first = await start();
    const seeded = await first.invoke<RequestRecord[]>(CHANNELS.list);
    expect(seeded.map((r) => r.id).sort()).toEqual(["demo-1", "demo-2", "demo-3"]);

    const store = await first.host.db.open("requests", { migrations: MIGRATIONS });
    await store.run("DELETE FROM requests WHERE id = 'demo-1'");
    // A second activation over the same file: the seed is a migration, so it
    // never runs again.
    const dir = dirs[0]!;
    const again = createMockHost({
      pluginId: PLUGIN_ID,
      projectRoot: PROJECT_ROOT,
      databases: { directory: dir, declared: ["requests", "operations"] },
    });
    disposers.push(await activate(again));
    const handler = again.registeredHandlers.find((entry) => entry.channel === CHANNELS.list)!;
    const after = (await handler.handler({} as never, {})) as RequestRecord[];
    expect(after.map((r) => r.id).sort()).toEqual(["demo-2", "demo-3"]);
  });

  it("lets an agent's tool call change the data and tells the views to refetch", async () => {
    const { host, callTool, invoke } = await start();
    await invoke(CHANNELS.list);
    const { request } = await callTool<{ request: RequestRecord }>("add_request", {
      title: "Write the onboarding checklist",
      id: "onboarding",
    });
    expect(request.status).toBe("open");
    await until(
      () => host.postToPanelCalls.some((call) => call.channel === EVENTS.requestsChanged),
      "a requests-changed push"
    );
    // A retried call with the same id makes no duplicate.
    await callTool("add_request", { title: "Write the onboarding checklist", id: "onboarding" });
    const listed = await callTool<{ requests: RequestRecord[] }>("list_requests", {});
    expect(listed.requests.filter((r) => r.id === "onboarding")).toHaveLength(1);
  });

  it("refuses an update from a stale revision and hands back the current request", async () => {
    const { callTool } = await start();
    const moved = await callTool<{ ok: boolean; request: RequestRecord }>("update_request", {
      id: "demo-1",
      revision: 1,
      status: "in_progress",
    });
    expect(moved.ok).toBe(true);
    expect(moved.request.revision).toBe(2);

    const stale = await callTool<{ ok: false; reason: string; current: RequestRecord }>(
      "update_request",
      { id: "demo-1", revision: 1, status: "done" }
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });
    expect(stale.current.status).toBe("in_progress");
  });

  it("drafts the first workflow into an agent the user picks, never sending it", async () => {
    const { host, runAction } = await start();
    host.simulateAgentsChange([
      {
        terminalId: "term-1",
        title: "Claude",
        agentId: "claude",
        worktree: null,
        isFocused: true,
        canDraft: true,
      },
    ]);
    host.simulateSendToAgentPick("term-1");
    const result = await runAction("first-request");
    expect(result).toEqual({ status: "drafted", terminalId: "term-1" });
    expect(host.sentToAgentCalls).toHaveLength(1);
    expect(host.sentToAgentCalls[0]!.text).toContain("list_requests");
  });

  it("opens its own connection page from the command the tour and setup point at", async () => {
    const { host, runAction } = await start();
    await runAction("open-connection");
    expect(host.dispatchedActions.at(-1)).toMatchObject({
      actionId: "plugin.openSettings",
      args: { pluginId: "acme.requests", section: "custom", page: "connection" },
    });
  });

  it("fails a report cleanly until the provider is connected", async () => {
    const { callTool, invoke } = await start();
    const started = await callTool<{ operationId: string }>("generate_report", {});
    await until(
      async () =>
        (await callTool<{ state: string }>("get_report", { operationId: started.operationId }))
          .state === "failed",
      "the report to fail"
    );
    const report = await callTool<{ error: string }>("get_report", {
      operationId: started.operationId,
    });
    expect(report.error).toMatch(/Connect the report provider/);

    await invoke(CHANNELS.connect, { workspace: "Demo workspace" });
    expect(await invoke(CHANNELS.connection)).toEqual({
      connected: true,
      workspace: "Demo workspace",
    });
  });

  it("previews a finished report as an artifact, and re-imports it once the handle expires", async () => {
    const { host, invoke } = await start({ providerWorkspace: "Demo workspace" });
    const store = await host.db.open("requests", { migrations: MIGRATIONS });
    await invoke(CHANNELS.list);
    const reportPath = `${PROJECT_ROOT}/.daintree/data/acme.requests/reports/report-1.svg`;
    await host.fs.mkdir(path.posix.dirname(reportPath));
    await host.fs.writeFile(reportPath, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await store.run(
      "INSERT INTO reports (id, path, request_count, created_at) VALUES ('report-1', ?, 3, '2026-01-08T00:00:00.000Z')",
      [reportPath]
    );

    const first = await invoke<{ id: string; mimeType: string }>(CHANNELS.reportArtifact, {
      reportId: "report-1",
    });
    expect(first.mimeType).toBe("image/svg+xml");
    expect(JSON.stringify(first)).not.toContain(reportPath);
    const same = await invoke<{ id: string }>(CHANNELS.reportArtifact, { reportId: "report-1" });
    expect(same.id).toBe(first.id);

    host.simulateArtifactExpiry(first.id);
    const fresh = await invoke<{ id: string }>(CHANNELS.reportArtifact, { reportId: "report-1" });
    expect(fresh.id).not.toBe(first.id);
  });
});
