import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const projects = vi.hoisted(() => new Map<string, { name: string }>());
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => projects.get(id) ?? null },
}));
vi.mock("../plugin/service.js", () => ({ getPluginService: vi.fn() }));

import type { ClientEndpoint } from "../../endpoint.js";
import type { IpcContext } from "../../types.js";
import { _resetUnsavedPluginPanelsForTests } from "../../../services/plugin/pluginUnsavedPanels.js";
import { handleGetUnsavedPanels, handleReportUnsavedPanels } from "../plugin/runtime.js";

let nextId = 1;

class FakeContents extends EventEmitter {
  id = nextId++;
  isDestroyed() {
    return false;
  }
}

function localCtx(wc: FakeContents, projectId: string | null): IpcContext {
  return {
    event: { sender: wc },
    webContentsId: wc.id,
    projectId,
    endpoint: { handle: wc.id, kind: "local-view" },
  } as unknown as IpcContext;
}

function remoteCtx(handle: number, projectId: string) {
  const listeners = new Set<() => void>();
  const endpoint = {
    handle,
    kind: "remote-view",
    isClosed: () => false,
    onClose: (cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
  } as unknown as ClientEndpoint;
  const ctx = { event: null, webContentsId: handle, projectId, endpoint } as unknown as IpcContext;
  return { ctx, close: () => [...listeners].forEach((cb) => cb()) };
}

const draft = { panelId: "p1", pluginId: "acme.demo", title: "Invoice draft" };

afterEach(() => {
  _resetUnsavedPluginPanelsForTests();
  projects.clear();
});

describe("unsaved plugin panel handlers (#15031)", () => {
  it("lists a panel open in two views of one project once, with its project's name", async () => {
    projects.set("project-a", { name: "Accounts" });
    const first = new FakeContents();
    const second = new FakeContents();
    await handleReportUnsavedPanels(localCtx(first, "project-a"), [draft]);
    await handleReportUnsavedPanels(localCtx(second, "project-a"), [draft]);
    await handleReportUnsavedPanels(localCtx(new FakeContents(), null), [
      { ...draft, panelId: "p2", title: "Scratch" },
    ]);

    expect(await handleGetUnsavedPanels("acme.demo")).toEqual([
      { panelId: "p1", title: "Invoice draft", projectId: "project-a", projectName: "Accounts" },
      { panelId: "p2", title: "Scratch", projectId: null, projectName: null },
    ]);
  });

  it("forgets a local view's report when its document navigates", async () => {
    const wc = new FakeContents();
    await handleReportUnsavedPanels(localCtx(wc, "project-a"), [draft]);
    wc.emit("did-navigate");

    expect(await handleGetUnsavedPanels("acme.demo")).toEqual([]);
  });

  it("counts a remote view until its endpoint closes", async () => {
    const remote = remoteCtx(-4, "project-a");
    await handleReportUnsavedPanels(remote.ctx, [draft]);
    expect(await handleGetUnsavedPanels("acme.demo")).toHaveLength(1);

    remote.close();
    expect(await handleGetUnsavedPanels("acme.demo")).toEqual([]);
  });

  it("answers an empty list for a blank plugin id", async () => {
    await handleReportUnsavedPanels(localCtx(new FakeContents(), "project-a"), [draft]);
    expect(await handleGetUnsavedPanels("")).toEqual([]);
  });
});
