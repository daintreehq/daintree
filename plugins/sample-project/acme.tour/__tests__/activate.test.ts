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
  // The mock routes `dispatch` to the plugin's OWN registered actions and
  // returns NOT_FOUND for anything else, so the two built-ins the sample calls
  // have to be seeded. That is faithful: a real failed dispatch resolves
  // `{ ok: false }` rather than throwing, which is what the sample guards.
  host.setDispatchResult("panel.openPluginPanel", { ok: true, result: { panelId: "panel-new" } });
  host.setDispatchResult("file.openPanel", { ok: true, result: { panelId: "panel-file" } });
  const dispose = await activate(host as PluginHostApi);
  return { host, dispose };
}

function mount(host: ReturnType<typeof createMockHost>, panelId: string) {
  host.simulatePanelLifecycleChange({
    panelId,
    panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
    pluginId: PLUGIN_ID,
    phase: "mounted",
  });
}

function transition(
  host: ReturnType<typeof createMockHost>,
  panelId: string,
  phase: "hidden" | "backgrounded" | "removed" | "trashed" | "render-failed"
) {
  host.simulatePanelLifecycleChange({
    panelId,
    panelKindId: `project:${PROJECT_ID}/acme.tour/tour`,
    pluginId: PLUGIN_ID,
    phase,
  });
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
    mount(host, "panel-1");

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

  it("updates every mounted panel when another one opens, not just the newcomer", async () => {
    const { host } = await activated();
    mount(host, "panel-1");
    const afterFirst = host.postToPanelCalls.length;
    mount(host, "panel-2");

    // Both panels must be told the count is now 2 — a push that reached only
    // panel-2 would leave panel-1 permanently showing "1".
    const fanout = host.postToPanelCalls.slice(afterFirst);
    expect(fanout.map((c) => c.panelId).sort()).toEqual(["panel-1", "panel-2"]);
    expect(fanout.every((c) => JSON.stringify(c.payload) === JSON.stringify({ panels: 2 }))).toBe(
      true
    );
  });

  it.each(["hidden", "backgrounded", "trashed", "render-failed"] as const)(
    "stops counting a panel whose view went %s, not just one removed",
    async (phase) => {
      const { host } = await activated();
      mount(host, "panel-1");
      mount(host, "panel-2");
      expect(host.postToPanelCalls.at(-1)?.payload).toEqual({ panels: 2 });

      // These phases tear the React subtree down while the panel record lives
      // on, so the view is no longer listening — a plugin that only reacts to
      // `removed` keeps pushing at nothing and shows a count that never
      // recovers.
      transition(host, "panel-1", phase);

      const remaining = host.postToPanelCalls.filter((c) => c.payload !== undefined).at(-1);
      expect(remaining?.payload).toEqual({ panels: 1 });
      expect(remaining?.panelId).toBe("panel-2");
    }
  );

  it("counts a panel again when it remounts", async () => {
    const { host } = await activated();
    mount(host, "panel-1");
    transition(host, "panel-1", "hidden");
    mount(host, "panel-1");
    expect(host.postToPanelCalls.at(-1)?.payload).toEqual({ panels: 1 });
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

  it("registers under the id the manifest declares, with an empty capability claim", async () => {
    // The host replaces the manifest descriptor rather than diffing it, so the
    // load-bearing parts are the id (which is what makes the command reachable)
    // and `requires`, which must be a subset of the manifest's capabilities.
    const { host } = await activated();
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.descriptor).toMatchObject({
      id: "open-tour",
      kind: "command",
      danger: "safe",
      requires: [],
    });
  });

  it("surfaces a failed dispatch instead of returning it as success", async () => {
    // `host.dispatch` resolves `{ ok: false }` rather than throwing, so a
    // handler that returns it raw hands the view a truthy object and the
    // button silently does nothing. The sample must reject instead.
    const { host } = await activated();
    host.setDispatchResult("file.openPanel", {
      ok: false,
      error: { code: "NOT_FOUND", message: "no such panel" },
    });

    await expect(
      handler(host, "reveal")(makeCtx(), { path: "/repo/notes.md", rootPath: "/repo" })
    ).rejects.toThrow("file.openPanel failed: no such panel");
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
