import { describe, expect, it } from "vitest";
// @ts-expect-error — hand-written ESM shipped as the load contract; there is no
// build step and therefore no declaration file. The point of the sample is that
// this file runs verbatim.
import { activate } from "../dist/index.mjs";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import type { PluginIpcContext, PluginHostApi } from "../../../../shared/types/plugin.js";

// A real project id is 64 hex characters (`PROJECT_ID_PATTERN`,
// shared/utils/workspaceIds.ts) — using a realistic one keeps the instance key
// and panel kind ids here the same shape the host actually builds.
const PROJECT_ID = "a".repeat(64);
const PLUGIN_ID = `project__${PROJECT_ID}__acme.tour`;

function makeCtx(overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: PROJECT_ID,
    worktreeId: "wt-1",
    webContentsId: 0,
    pluginId: PLUGIN_ID,
    ...overrides,
  };
}

async function activated() {
  const host = createMockHost({ pluginId: PLUGIN_ID });
  const dispose = await activate(host as PluginHostApi);
  return { host, dispose };
}

function handler(host: ReturnType<typeof createMockHost>, channel: string) {
  const record = host.registeredHandlers.find((h) => h.channel === channel);
  expect(record, `no handler registered for "${channel}"`).toBeDefined();
  return record!.handler;
}

describe("acme.tour — the calling convention it exists to demonstrate", () => {
  it("reads a channel payload from the second parameter", async () => {
    const { host } = await activated();
    await host.fs.writeFile("/repo/notes.md", "one\ntwo\nthree");

    const result = await handler(host, "describe-file")(makeCtx(), { path: "/repo/notes.md" });
    expect(result).toEqual({
      path: "/repo/notes.md",
      lines: 3,
      characters: 13,
      projectId: PROJECT_ID,
    });
  });

  it("throws rather than silently misreading a payload put in the context slot", async () => {
    const { host } = await activated();
    await expect(
      handler(host, "describe-file")({ path: "/repo/notes.md" } as unknown as PluginIpcContext)
    ).rejects.toThrow("describe-file requires a path");
  });
});

describe("acme.tour — runtime ids", () => {
  it("qualifies its own panel kind as project:{projectId}/{manifestId}/{kindId}", async () => {
    const { host } = await activated();
    await handler(host, "open-another")(makeCtx());

    expect(host.dispatchedActions).toContainEqual({
      actionId: "panel.openPluginPanel",
      args: {
        kind: `project:${PROJECT_ID}/acme.tour/tour`,
        initialArgs: { openedBy: "tour" },
        reuseExisting: false,
      },
    });
  });

  it("refuses to build a panel kind with no owning project", async () => {
    const { host } = await activated();
    await expect(handler(host, "open-another")(makeCtx({ projectId: null }))).rejects.toThrow(
      "open-another needs a project"
    );
  });
});

describe("acme.tour — pushes and badges", () => {
  it("targets a push and a badge at the panel that just mounted", async () => {
    const { host } = await activated();
    host.simulatePanelLifecycleChange({
      panelId: "panel-1",
      panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
      pluginId: PLUGIN_ID,
      phase: "mounted",
    });

    expect(host.postToPanelCalls).toContainEqual({
      channel: "tour-state",
      payload: { panels: 1 },
      panelId: "panel-1",
    });
    expect(host.setPanelBadgeCalls.at(-1)).toEqual({
      panelId: "panel-1",
      badge: { kind: "label", text: "1", color: "default", tooltip: "Panels open in this tour" },
    });
  });

  it("stops counting a panel once it is removed", async () => {
    const { host } = await activated();
    for (const panelId of ["panel-1", "panel-2"]) {
      host.simulatePanelLifecycleChange({
        panelId,
        panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
        pluginId: PLUGIN_ID,
        phase: "mounted",
      });
    }
    expect(host.postToPanelCalls.at(-1)?.payload).toEqual({ panels: 2 });

    host.simulatePanelLifecycleChange({
      panelId: "panel-1",
      panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
      pluginId: PLUGIN_ID,
      phase: "removed",
    });
    host.simulatePanelLifecycleChange({
      panelId: "panel-3",
      panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
      pluginId: PLUGIN_ID,
      phase: "mounted",
    });
    expect(host.postToPanelCalls.at(-1)?.payload).toEqual({ panels: 2 });
  });
});

describe("acme.tour — built-in dispatch and disposal", () => {
  it("hands a path to the host's own file panel", async () => {
    const { host } = await activated();
    await handler(host, "reveal")(makeCtx(), { path: "/repo/notes.md", rootPath: "/repo" });

    expect(host.dispatchedActions).toContainEqual({
      actionId: "file.openPanel",
      args: { path: "/repo/notes.md", rootPath: "/repo" },
    });
  });

  it("registers the manifest-declared command with a matching descriptor", async () => {
    const { host } = await activated();
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.descriptor).toMatchObject({
      id: "open-tour",
      kind: "command",
      danger: "safe",
      requires: [],
    });
  });

  it("unsubscribes from panel lifecycle on disposal", async () => {
    const { host, dispose } = await activated();
    dispose();

    const before = host.postToPanelCalls.length;
    host.simulatePanelLifecycleChange({
      panelId: "panel-9",
      panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
      pluginId: PLUGIN_ID,
      phase: "mounted",
    });
    expect(host.postToPanelCalls.length).toBe(before);
  });
});
