import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSearchHit } from "@/hooks/usePluginSearch";

const { dispatchMock, notifyMock, panelConfigs } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
  panelConfigs: new Map<string, { extensionId: string }>(),
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (id: string) => panelConfigs.get(id),
}));

import { openPluginSearchHit } from "./openPluginSearchHit";

function hit(target: PluginSearchHit["row"]["target"], pluginId = "acme.notes"): PluginSearchHit {
  return {
    id: "plugin:acme.notes.notes:n1",
    providerKey: "acme.notes.notes",
    providerTitle: "Notes",
    pluginId,
    pluginName: "Acme Notes",
    row: { id: "n1", label: "Groceries", iconId: "notebook", target },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  notifyMock.mockReset();
  panelConfigs.clear();
  panelConfigs.set("acme.notes.notes", { extensionId: "acme.notes" });
});

describe("openPluginSearchHit", () => {
  it("opens the plugin's own panel, reusing an open one and handing it the result's args", () => {
    openPluginSearchHit(
      hit({ type: "panel", panelKindId: "acme.notes.notes", args: { noteId: 1 } })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      "panel.openPluginPanel",
      { kind: "acme.notes.notes", initialArgs: { noteId: 1 }, reuseExisting: true },
      { source: "user" }
    );
  });

  it("dispatches the plugin's own command with the result's args", () => {
    openPluginSearchHit(hit({ type: "command", actionId: "acme.notes.open", args: { id: 1 } }));
    expect(dispatchMock).toHaveBeenCalledWith("acme.notes.open", { id: 1 }, { source: "user" });
  });

  it.each([
    ["another plugin's panel", hit({ type: "panel", panelKindId: "other.panel", args: {} })],
    ["another plugin's command", hit({ type: "command", actionId: "other.notes.open", args: {} })],
    [
      "a built-in action",
      hit({ type: "command", actionId: "panel.openPluginPanel", args: {} }, "panel"),
    ],
  ])("refuses %s at the point of dispatch", (_label, forged) => {
    panelConfigs.set("other.panel", { extensionId: "other" });
    openPluginSearchHit(forged);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("says which plugin didn't complete a refused open, with a retry", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "boom" } });
    openPluginSearchHit(hit({ type: "command", actionId: "acme.notes.open", args: {} }));
    await flush();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't open Groceries",
        priority: "high",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );
  });
});
