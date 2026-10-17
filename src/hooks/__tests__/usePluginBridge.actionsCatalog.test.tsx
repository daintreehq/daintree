// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";

const manifest = (id: string, danger: ActionManifestEntry["danger"]) =>
  ({
    id,
    name: id,
    title: id,
    description: "",
    category: "test",
    kind: "command",
    danger,
    enabled: true,
    requiresArgs: false,
  }) as unknown as ActionManifestEntry;

const catalog = vi.hoisted(() => new Map<string, unknown>());
const denied = vi.hoisted(() => new Set<string>());

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: () => [...catalog.values()],
    get: (id: string) => catalog.get(id) ?? null,
    deniesPluginDispatch: (id: string) => denied.has(id),
  },
}));
vi.mock("@/services/plugin/pluginPanelReload", () => ({
  handlePanelReloadRequest: vi.fn(),
}));

import { usePluginBridge } from "@/hooks/usePluginBridge";

let requestList: ((request: { requestId: string }) => void) | null = null;
let requestGet: ((request: { requestId: string; actionId: string }) => void) | null = null;
const sendActionsListResponse = vi.fn();
const sendActionsGetResponse = vi.fn();

beforeEach(() => {
  catalog.clear();
  denied.clear();
  catalog.set("safe.open", manifest("safe.open", "safe"));
  catalog.set("agent.launchMany", manifest("agent.launchMany", "safe"));
  catalog.set("git.commit", manifest("git.commit", "confirm"));
  catalog.set("app.restricted", manifest("app.restricted", "restricted"));
  denied.add("agent.launchMany");
  sendActionsListResponse.mockReset();
  sendActionsGetResponse.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      pluginBridge: {
        onDispatchActionRequest: () => () => {},
        onActionsListRequest: (cb: typeof requestList) => {
          requestList = cb;
          return () => {};
        },
        onActionsGetRequest: (cb: typeof requestGet) => {
          requestGet = cb;
          return () => {};
        },
        sendActionsListResponse,
        sendActionsGetResponse,
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("usePluginBridge action catalog (#13456)", () => {
  it("leaves actions dispatch refuses for plugins out of list()", () => {
    catalog.delete("app.restricted");
    renderHook(() => usePluginBridge());
    requestList?.({ requestId: "r1" });
    const ids = sendActionsListResponse.mock.calls[0]![0].entries.map(
      (entry: { id: string }) => entry.id
    );
    expect(ids).toEqual(["safe.open", "git.commit"]);
  });

  it.each([
    ["safe.open", "safe.open"],
    ["git.commit", "git.commit"],
    ["agent.launchMany", null],
    ["app.restricted", null],
    ["unknown.id", null],
  ])("get(%s) answers the entry only when plugins can dispatch it", (actionId, expected) => {
    renderHook(() => usePluginBridge());
    requestGet?.({ requestId: "r1", actionId });
    const { entry } = sendActionsGetResponse.mock.calls[0]![0];
    expect(entry?.id ?? null).toBe(expected);
  });
});
