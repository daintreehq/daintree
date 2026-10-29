import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetUnsavedPluginPanelsForTests,
  getUnsavedPluginPanels,
  recordUnsavedPluginPanels,
  watchSourceHandle,
  watchWebContentsDocument,
} from "../pluginUnsavedPanels.js";
import {
  makeInstalledProjectInstanceKey,
  makeProjectPluginInstanceKey,
} from "../../../../shared/types/plugin/instanceKeys.js";

let nextId = 1;

class FakeContents extends EventEmitter {
  id = nextId++;
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function report(wc: FakeContents, panels: unknown, projectId: string | null = "project-a"): void {
  recordUnsavedPluginPanels(
    wc.id,
    watchWebContentsDocument(wc as unknown as Electron.WebContents),
    projectId,
    panels
  );
}

const panel = (panelId: string, pluginId = "acme.demo", title = panelId) => ({
  panelId,
  pluginId,
  title,
});

afterEach(() => {
  _resetUnsavedPluginPanelsForTests();
});

describe("pluginUnsavedPanels", () => {
  it("unions what every view reported for the plugin, with each view's project", () => {
    const a = new FakeContents();
    const b = new FakeContents();
    report(a, [panel("p1"), panel("p2", "other.plugin")], "project-a");
    report(b, [panel("p3")], "project-b");

    expect(getUnsavedPluginPanels("acme.demo")).toEqual([
      { panelId: "p1", pluginId: "acme.demo", title: "p1", projectId: "project-a" },
      { panelId: "p3", pluginId: "acme.demo", title: "p3", projectId: "project-b" },
    ]);
    expect(getUnsavedPluginPanels("other.plugin").map((p) => p.panelId)).toEqual(["p2"]);
  });

  it("counts an installed package's per-project instances but not a repository namesake", () => {
    const wc = new FakeContents();
    report(wc, [
      panel("installed", makeInstalledProjectInstanceKey("a".repeat(64), "acme.demo")),
      panel("repository", makeProjectPluginInstanceKey("a".repeat(64), "acme.demo")),
    ]);

    expect(getUnsavedPluginPanels("acme.demo").map((p) => p.panelId)).toEqual(["installed"]);
  });

  it("replaces a view's report, and an empty one forgets the view and its listeners", () => {
    const wc = new FakeContents();
    report(wc, [panel("p1")]);
    report(wc, [panel("p2")]);
    expect(getUnsavedPluginPanels("acme.demo").map((p) => p.panelId)).toEqual(["p2"]);
    expect(wc.listenerCount("did-navigate")).toBe(1);

    report(wc, []);
    expect(getUnsavedPluginPanels("acme.demo")).toEqual([]);
    expect(wc.listenerCount("did-navigate")).toBe(0);
    expect(wc.listenerCount("did-fail-load")).toBe(0);
    expect(wc.listenerCount("destroyed")).toBe(0);
    expect(wc.listenerCount("render-process-gone")).toBe(0);
  });

  it("forgets a view whose document navigated, crashed or was destroyed", () => {
    const navigated = new FakeContents();
    const crashed = new FakeContents();
    const destroyed = new FakeContents();
    report(navigated, [panel("p1")]);
    report(crashed, [panel("p2")]);
    report(destroyed, [panel("p3")]);

    navigated.emit("did-navigate");
    crashed.emit("render-process-gone");
    destroyed.destroy();

    expect(getUnsavedPluginPanels("acme.demo")).toEqual([]);
    expect(navigated.listenerCount("did-navigate")).toBe(0);
    expect(crashed.listenerCount("did-navigate")).toBe(0);
  });

  it("forgets a view on a failed main-frame load but not an aborted or subframe one", () => {
    const wc = new FakeContents();
    report(wc, [panel("p1")]);

    wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "app://x", true);
    wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://x", false);
    expect(getUnsavedPluginPanels("acme.demo")).toHaveLength(1);

    wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "app://x", true);
    expect(getUnsavedPluginPanels("acme.demo")).toEqual([]);
  });

  it("does not let a forgotten report's listener clear the view's next one", () => {
    const wc = new FakeContents();
    report(wc, [panel("p1")]);
    wc.emit("did-navigate");
    report(wc, [panel("p2")]);

    expect(getUnsavedPluginPanels("acme.demo").map((p) => p.panelId)).toEqual(["p2"]);
    expect(wc.listenerCount("did-navigate")).toBe(1);
  });

  it("forgets a remote view when its endpoint closes", () => {
    const endpoint = new EventEmitter();
    const handle = {
      id: -7,
      once: (event: "destroyed", listener: () => void) => endpoint.once(event, listener),
      removeListener: (event: "destroyed", listener: () => void) =>
        endpoint.removeListener(event, listener),
    };
    recordUnsavedPluginPanels(handle.id, watchSourceHandle(handle), "project-a", [panel("p1")]);
    expect(getUnsavedPluginPanels("acme.demo")).toHaveLength(1);

    endpoint.emit("destroyed");
    expect(getUnsavedPluginPanels("acme.demo")).toEqual([]);
  });

  it("drops malformed entries and caps titles", () => {
    const wc = new FakeContents();
    report(wc, [
      null,
      { panelId: "", pluginId: "acme.demo", title: "empty id" },
      { panelId: "p1", pluginId: 42, title: "bad plugin" },
      { panelId: "p2", pluginId: "acme.demo", title: 7 },
      { panelId: "p3", pluginId: "acme.demo", title: "x".repeat(500) },
    ]);

    const panels = getUnsavedPluginPanels("acme.demo");
    expect(panels.map((p) => p.panelId)).toEqual(["p2", "p3"]);
    expect(panels[0]!.title).toBe("");
    expect(panels[1]!.title.length).toBeLessThan(500);
  });

  it("ignores a report that is not a list", () => {
    const wc = new FakeContents();
    report(wc, { panelId: "p1", pluginId: "acme.demo", title: "p1" });
    expect(getUnsavedPluginPanels("acme.demo")).toEqual([]);
    expect(wc.listenerCount("destroyed")).toBe(0);
  });
});
