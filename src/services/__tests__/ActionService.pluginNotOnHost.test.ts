// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() }),
  },
}));
vi.mock("../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: () => null, getDisplayCombo: () => "" },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { ActionService } from "../ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { AnyActionDefinition } from "../actions/actionTypes";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

type HostWindow = { __DAINTREE_HOST_ID__?: { id: string } };

function action(id: string, pluginId?: string): ActionDefinition {
  const definition = {
    id: id as ActionId,
    title: id,
    description: id,
    category: "test",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => "ran",
  } as ActionDefinition;
  if (pluginId) (definition as AnyActionDefinition).pluginId = pluginId;
  return definition;
}

function attachToHost(id: string | null): void {
  const target = window as unknown as HostWindow;
  if (id === null) delete target.__DAINTREE_HOST_ID__;
  else target.__DAINTREE_HOST_ID__ = { id };
}

const diff = vi.fn();

describe("dispatching an action whose plugin isn't on the window's host", () => {
  let service: ActionService;

  beforeEach(() => {
    service = new ActionService();
    service.register(action("file.openInEditor"));
    _resetHostPlatformForTests();
    diff.mockReset();
    diff.mockResolvedValue([
      { pluginId: "acme.linear", displayName: "Linear", group: "only-here" },
      { pluginId: "acme.graph", displayName: "Graph", group: "same" },
    ]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { pluginParity: { diff } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
    attachToHost(null);
    _resetHostPlatformForTests();
  });

  it("returns PLUGIN_NOT_ON_HOST with the plugin and host in a remote window", async () => {
    attachToHost("studio");
    setHostPlatformInfo({ hostName: "studio-01" });

    const result = await service.dispatch("acme.linear.createIssue" as ActionId, {});

    expect(diff).toHaveBeenCalledWith({ hostId: "studio" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLUGIN_NOT_ON_HOST");
    expect(result.error.message).toContain("studio-01");
    expect(result.error.details).toEqual({
      code: "PLUGIN_NOT_ON_HOST",
      pluginId: "acme.linear",
      hostId: "studio",
    });
  });

  it("covers a plugin that was here and has since gone from the host", async () => {
    attachToHost("studio");
    service.register(action("daintree.notes.open", "daintree.notes"));
    service.unregister("daintree.notes.open" as ActionId);

    const result = await service.dispatch("daintree.notes.open" as ActionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PLUGIN_NOT_ON_HOST");
    expect(result.error.details).toMatchObject({ pluginId: "daintree.notes", hostId: "studio" });
    expect(diff).not.toHaveBeenCalled();
  });

  it("keeps an id no plugin of this machine owns NOT_FOUND", async () => {
    attachToHost("studio");
    for (const id of ["file.noSuchThing", "acme.graph.summarize"]) {
      const result = await service.dispatch(id as ActionId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code, id).toBe("NOT_FOUND");
      expect(result.error.details).toBeUndefined();
    }
  });

  it("falls back to NOT_FOUND when the plugin comparison can't be read", async () => {
    attachToHost("studio");
    diff.mockRejectedValue(new Error("host unreachable"));
    const result = await service.dispatch("acme.linear.createIssue" as ActionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("changes nothing in a local window", async () => {
    const result = await service.dispatch("acme.linear.createIssue" as ActionId);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: 'Action "acme.linear.createIssue" not found in registry',
      },
    });
    expect(diff).not.toHaveBeenCalled();
  });

  it("still runs a plugin action the host has", async () => {
    attachToHost("studio");
    service.register(action("acme.linear.createIssue", "acme.linear"));
    await expect(service.dispatch("acme.linear.createIssue" as ActionId)).resolves.toMatchObject({
      ok: true,
      result: "ran",
    });
  });
});
