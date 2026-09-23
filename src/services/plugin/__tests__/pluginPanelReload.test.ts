import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  panels: {} as Record<string, { kind?: string }>,
  kinds: {} as Record<string, { extensionId?: string }>,
  cached: false,
}));

vi.mock("@/store/storeAccessors", () => ({
  getPanelStoreSnapshot: () => ({ panelsById: state.panels, panelIds: [], tabGroups: new Map() }),
}));
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (kindId: string) => state.kinds[kindId],
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => state.cached,
}));

import {
  handlePanelReloadRequest,
  registerPanelReloadHandler,
  resetPanelReloadHandlersForTests,
} from "../pluginPanelReload";

function request(overrides: Partial<Parameters<typeof handlePanelReloadRequest>[0]> = {}) {
  return {
    requestId: "r1",
    panelId: "p1",
    pluginId: "acme",
    expiresAt: Date.now() + 10_000,
    ...overrides,
  };
}

beforeEach(() => {
  resetPanelReloadHandlersForTests();
  state.panels = { p1: { kind: "acme.dash" }, t1: { kind: "terminal" } };
  state.kinds = { "acme.dash": { extensionId: "acme" }, terminal: {} };
  state.cached = false;
});

describe("handlePanelReloadRequest", () => {
  it("hands a valid request to the panel's registered view", async () => {
    const handler = vi.fn(async () => "scheduled" as const);
    registerPanelReloadHandler("p1", handler);
    await expect(handlePanelReloadRequest(request())).resolves.toEqual({
      requestId: "r1",
      result: "scheduled",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("answers not-mounted for a live panel with no registered view", async () => {
    await expect(handlePanelReloadRequest(request())).resolves.toEqual({
      requestId: "r1",
      result: "not-mounted",
    });
  });

  it("answers not-mounted when the panel record is gone", async () => {
    const handler = vi.fn(async () => "scheduled" as const);
    registerPanelReloadHandler("p1", handler);
    state.panels = {};
    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "not-mounted",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses another plugin's panel against the live kind registry", async () => {
    const handler = vi.fn(async () => "scheduled" as const);
    registerPanelReloadHandler("p1", handler);
    await expect(handlePanelReloadRequest(request({ pluginId: "other" }))).resolves.toEqual({
      requestId: "r1",
      rejected: "foreign",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a panel whose kind belongs to no plugin", async () => {
    await expect(handlePanelReloadRequest(request({ panelId: "t1" }))).resolves.toEqual({
      requestId: "r1",
      rejected: "non-plugin",
    });
  });

  it("answers unavailable, not non-plugin, while the kind is unregistered", async () => {
    state.kinds = {};
    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "unavailable",
    });
  });

  it("drops a request that expired before it was delivered", async () => {
    const handler = vi.fn(async () => "scheduled" as const);
    registerPanelReloadHandler("p1", handler);
    await expect(
      handlePanelReloadRequest(request({ expiresAt: Date.now() - 1 }))
    ).resolves.toMatchObject({ result: "unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not act in a cached project view", async () => {
    const handler = vi.fn(async () => "scheduled" as const);
    registerPanelReloadHandler("p1", handler);
    state.cached = true;
    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "unavailable",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers unavailable when the view's handler throws", async () => {
    registerPanelReloadHandler("p1", async () => {
      throw new Error("boom");
    });
    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "unavailable",
    });
  });
});

describe("registerPanelReloadHandler", () => {
  it("lets a stale cleanup leave the newer registration in place", async () => {
    const first = vi.fn(async () => "scheduled" as const);
    const second = vi.fn(async () => "rate-limited" as const);
    const disposeFirst = registerPanelReloadHandler("p1", first);
    registerPanelReloadHandler("p1", second);
    disposeFirst();

    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "rate-limited",
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("unregisters on cleanup", async () => {
    const dispose = registerPanelReloadHandler("p1", async () => "scheduled");
    dispose();
    await expect(handlePanelReloadRequest(request())).resolves.toMatchObject({
      result: "not-mounted",
    });
  });
});
