// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  viewKeys: new Map<number, string>(),
  registry: null as null | {
    getPrimary: () => unknown;
    all: () => unknown[];
  },
  singletonView: null as null | { webContents: unknown },
}));

vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => state.registry,
  getProjectViewManager: () =>
    state.singletonView ? { getActiveView: () => state.singletonView } : null,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (id: number) => state.viewKeys.get(id) ?? null,
  getWebContentsForProject: () => [],
  isCachedViewWebContents: () => false,
}));

import { isRemoteHostView, resolveAmbientWebContents } from "../rendererTargeting.js";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../../remote/runtime.js";

interface FakeView {
  webContents: { id: number; isDestroyed: () => boolean };
}

let nextId = 1;

function view(viewKey: string | null = null): FakeView {
  const id = nextId++;
  if (viewKey !== null) state.viewKeys.set(id, viewKey);
  return { webContents: { id, isDestroyed: () => false } };
}

function windowShowing(active: FakeView) {
  return {
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: { getActiveView: () => active } },
  };
}

/** A registry whose `all()` lists `before`, then the primary window, then `others`. */
function useRegistry(primary: FakeView | null, others: FakeView[], before: FakeView[] = []): void {
  const primaryCtx = primary ? windowShowing(primary) : undefined;
  const all = [
    ...before.map(windowShowing),
    ...(primaryCtx ? [primaryCtx] : []),
    ...others.map(windowShowing),
  ];
  state.registry = { getPrimary: () => primaryCtx, all: () => all };
}

afterEach(() => {
  state.viewKeys.clear();
  state.registry = null;
  state.singletonView = null;
  _resetRemoteServicesForTest();
});

describe("isRemoteHostView", () => {
  it("reads a project view's host from its key", () => {
    expect(isRemoteHostView(view("staging-server:proj-1").webContents.id)).toBe(true);
    expect(isRemoteHostView(view("proj-1").webContents.id)).toBe(false);
  });

  it("follows the window binding for a view with no project yet", () => {
    const bound = view();
    const local = view();
    registerRemoteService("windowHosts", {
      viewHost: (id: number) => (id === bound.webContents.id ? "staging-server" : "local"),
    } as never);
    expect(isRemoteHostView(bound.webContents.id)).toBe(true);
    expect(isRemoteHostView(local.webContents.id)).toBe(false);
  });

  it("lets a project view's key win over its window's binding", () => {
    const remoteKeyed = view("staging-server:proj-1");
    const localKeyed = view("proj-2");
    registerRemoteService("windowHosts", {
      viewHost: (id: number) => (id === localKeyed.webContents.id ? "staging-server" : "local"),
    } as never);
    expect(isRemoteHostView(remoteKeyed.webContents.id)).toBe(true);
    expect(isRemoteHostView(localKeyed.webContents.id)).toBe(false);
  });

  it("treats a view as this machine's when Remote Hosts isn't running", () => {
    expect(isRemoteHostView(view().webContents.id)).toBe(false);
  });
});

describe("resolveAmbientWebContents (#17214)", () => {
  it("asks the primary window first, wherever the registry lists it", () => {
    const primary = view("proj-primary");
    useRegistry(primary, [], [view("proj-listed-first")]);
    expect(resolveAmbientWebContents()).toBe(primary.webContents);
  });

  it("passes over a primary window showing a Remote Host's project for a local one", () => {
    const remote = view("staging-server:proj-r");
    const local = view("proj-local");
    useRegistry(remote, [local]);
    expect(resolveAmbientWebContents()).toBe(local.webContents);
  });

  it("finds nothing when every window is on a Remote Host", () => {
    useRegistry(view("staging-server:proj-r"), [view("other-host:proj-s")]);
    state.singletonView = view("staging-server:proj-t");
    expect(resolveAmbientWebContents()).toBeNull();
  });

  it("passes over a window bound to a Remote Host before any project shows there", () => {
    const bound = view();
    const local = view("proj-local");
    registerRemoteService("windowHosts", {
      viewHost: (id: number) => (id === bound.webContents.id ? "staging-server" : "local"),
    } as never);
    useRegistry(bound, [local]);
    expect(resolveAmbientWebContents()).toBe(local.webContents);
  });

  it("reaches the process-wide view manager when every registered window is on a Remote Host", () => {
    const local = view("proj-local");
    useRegistry(view("staging-server:proj-r"), [view("other-host:proj-s")]);
    state.singletonView = local;
    expect(resolveAmbientWebContents()).toBe(local.webContents);
  });

  it("applies the same rule to the process-wide view manager's fallback", () => {
    const local = view("proj-local");
    state.singletonView = view("staging-server:proj-r");
    expect(resolveAmbientWebContents()).toBeNull();
    state.singletonView = local;
    expect(resolveAmbientWebContents()).toBe(local.webContents);
  });

  it("still answers from a Remote Host's view for a read that names its host", () => {
    const remote = view("staging-server:proj-r");
    useRegistry(remote, [view("proj-local")]);
    expect(resolveAmbientWebContents({ includeRemoteHostViews: true })).toBe(remote.webContents);
  });

  it("lets that read reach a Remote Host's view anywhere down the chain", () => {
    const listed = view("staging-server:proj-r");
    useRegistry(null, [listed]);
    expect(resolveAmbientWebContents()).toBeNull();
    expect(resolveAmbientWebContents({ includeRemoteHostViews: true })).toBe(listed.webContents);

    state.registry = null;
    const singleton = view("staging-server:proj-s");
    state.singletonView = singleton;
    expect(resolveAmbientWebContents()).toBeNull();
    expect(resolveAmbientWebContents({ includeRemoteHostViews: true })).toBe(singleton.webContents);
  });
});
