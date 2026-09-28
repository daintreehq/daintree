import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ webContents: { fromId: vi.fn() } }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => null,
  getProjectViewManager: () => null,
}));

import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import type { DriveTarget } from "../../../services/DriveLeaseService.js";
import {
  _resetPluginFrontendRoutingForTesting,
  isPluginFrontendRoutingEnabled,
  onPluginFrontendChange,
  resolvePluginFrontend,
  runInPluginInvocation,
} from "../../../services/plugin/pluginFrontendRouting.js";
import { installPluginHostRouting } from "../hostRouting.js";
import type { DriveLeaseHolder } from "../../../../shared/types/remoteHosts.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

function endpoint(kind: ClientEndpoint["kind"], projectId: string | null = PROJECT) {
  let closed = false;
  const closers = new Set<() => void>();
  const ep: ClientEndpoint = {
    endpointId: `${kind}:1`,
    clientId: kind === "local-view" ? "local" : "client-mbp",
    projectId,
    kind,
    handle: kind === "local-view" ? 5 : -5,
    send: vi.fn(),
    request: vi.fn(),
    onClose: (cb) => {
      closers.add(cb);
      return { dispose: () => closers.delete(cb) };
    },
    isClosed: () => closed,
  };
  return {
    ep,
    close: () => {
      closed = true;
      for (const cb of closers) cb();
    },
  };
}

const holder = (isHostLocal: boolean): DriveLeaseHolder => ({
  leaseId: 1,
  endpointId: "x",
  clientId: isHostLocal ? "local" : "client-mbp",
  clientName: "greg-mbp",
  isHostLocal,
  acquiredAt: 0,
});

describe("plugin frontend routing in Host mode", () => {
  const targets = new Map<string, DriveTarget>();
  const leaseListeners = new Set<() => void>();
  let localProjectViews = new Set<string>();
  let anyLocalView = false;
  let teardown: () => void;

  beforeEach(() => {
    _resetPluginFrontendRoutingForTesting();
    targets.clear();
    leaseListeners.clear();
    localProjectViews = new Set();
    anyLocalView = false;
    teardown = installPluginHostRouting({
      lease: {
        getDriveTarget: (projectId) => targets.get(projectId) ?? { kind: "vacant" },
        onChange: (listener) => {
          const wrapped = () => listener({ projectId: PROJECT, holder: null });
          leaseListeners.add(wrapped);
          return () => leaseListeners.delete(wrapped);
        },
      },
      registry: { onChange: () => () => {} },
      hasLocalProjectView: (projectId) => localProjectViews.has(projectId),
      hasLocalView: () => anyLocalView,
    });
  });

  afterEach(() => {
    teardown();
    _resetPluginFrontendRoutingForTesting();
  });

  it("is off, and local, until Host mode installs it", () => {
    teardown();
    expect(isPluginFrontendRoutingEnabled()).toBe(false);
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "local" });
  });

  it("sends a project driven from another machine to that endpoint", () => {
    const { ep } = endpoint("remote-view");
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: ep });
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({
      kind: "remote",
      endpoint: ep,
      leaseId: 1,
    });
  });

  it("keeps a project driven from this machine local", () => {
    const { ep } = endpoint("local-view");
    targets.set(PROJECT, { kind: "live", holder: holder(true), endpoint: ep });
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "local" });
  });

  it("answers nobody for a vacant project with no window here", () => {
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "none", reason: "vacant" });
    localProjectViews.add(PROJECT);
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "local" });
  });

  it("holds a remote driver's project for its grace instead of handing it to this machine", () => {
    localProjectViews.add(PROJECT);
    targets.set(PROJECT, { kind: "reserved", holder: holder(false) });
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "none", reason: "reserved" });
  });

  it("binds a project plugin to its own project from its instance key", () => {
    const { ep } = endpoint("remote-view", OTHER);
    targets.set(OTHER, { kind: "live", holder: holder(false), endpoint: ep });
    expect(resolvePluginFrontend(null, `project__${OTHER}__acme.x`)).toEqual({
      kind: "remote",
      endpoint: ep,
      leaseId: 1,
    });
  });

  it("sends an app-global plugin's prompt to the caller of the invocation it runs inside", async () => {
    const { ep, close } = endpoint("remote-view");
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: ep });
    expect(resolvePluginFrontend(null, "acme.global")).toEqual({ kind: "none", reason: "vacant" });
    await runInPluginInvocation("acme.global", ep, async () => {
      await Promise.resolve();
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({
        kind: "remote",
        endpoint: ep,
        leaseId: 1,
      });
      // Another plugin's work inside this call is not this caller's.
      expect(resolvePluginFrontend(null, "acme.other")).toEqual({ kind: "none", reason: "vacant" });
    });
    // Outside any invocation nothing is remembered.
    anyLocalView = false;
    expect(resolvePluginFrontend(null, "acme.global")).toEqual({ kind: "none", reason: "vacant" });
    close();
  });

  it("keeps a call on its caller's project after the caller disconnects", async () => {
    const { ep, close } = endpoint("remote-view");
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: ep });
    await runInPluginInvocation("acme.global", ep, async () => {
      close();
      // Unrelated windows here never inherit the question.
      anyLocalView = true;
      localProjectViews.add(OTHER);
      targets.set(PROJECT, { kind: "reserved", holder: holder(false) });
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({
        kind: "none",
        reason: "reserved",
      });
      // Whoever drives that project next answers it.
      const next = endpoint("remote-view").ep;
      targets.set(PROJECT, {
        kind: "live",
        holder: { ...holder(false), leaseId: 2 },
        endpoint: next,
      });
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({
        kind: "remote",
        endpoint: next,
        leaseId: 2,
      });
      // Or a window here showing that same project, once nobody drives it.
      targets.set(PROJECT, { kind: "vacant" });
      localProjectViews.add(PROJECT);
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({ kind: "local" });
    });
  });

  it("never hands a project-less remote caller's call to a window here", async () => {
    const { ep, close } = endpoint("remote-view", null);
    anyLocalView = true;
    await runInPluginInvocation("acme.global", ep, async () => {
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({ kind: "remote", endpoint: ep });
      close();
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({
        kind: "none",
        reason: "vacant",
      });
    });
  });

  it("keeps two interleaved calls from different projects on their own callers", async () => {
    const a = endpoint("remote-view", PROJECT).ep;
    const b = { ...endpoint("remote-view", OTHER).ep, endpointId: "remote-view:2" };
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: a });
    targets.set(OTHER, { kind: "live", holder: holder(false), endpoint: b });
    let releaseA!: () => void;
    const aWaits = new Promise<void>((resolve) => (releaseA = resolve));
    const seen: Record<string, unknown> = {};
    const callA = runInPluginInvocation("acme.global", a, async () => {
      await aWaits;
      seen.a = resolvePluginFrontend(null, "acme.global");
    });
    const callB = runInPluginInvocation("acme.global", b, async () => {
      seen.b = resolvePluginFrontend(null, "acme.global");
    });
    await callB;
    releaseA();
    await callA;
    expect(seen.a).toEqual({ kind: "remote", endpoint: a, leaseId: 1 });
    expect(seen.b).toEqual({ kind: "remote", endpoint: b, leaseId: 1 });
  });

  it("keeps the caller's project even if its view moves while the call runs", async () => {
    const { ep } = endpoint("remote-view", PROJECT);
    const other = endpoint("remote-view", OTHER).ep;
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: ep });
    targets.set(OTHER, { kind: "live", holder: holder(false), endpoint: other });
    await runInPluginInvocation("acme.global", ep, async () => {
      (ep as { projectId: string | null }).projectId = OTHER;
      await Promise.resolve();
      expect(resolvePluginFrontend(null, "acme.global")).toEqual({
        kind: "remote",
        endpoint: ep,
        leaseId: 1,
      });
    });
  });

  it("treats a closed live endpoint as nobody, and a throwing lease as nobody", () => {
    const { ep, close } = endpoint("remote-view");
    targets.set(PROJECT, { kind: "live", holder: holder(false), endpoint: ep });
    close();
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({ kind: "none", reason: "reserved" });
    targets.set(PROJECT, undefined as never);
    teardown();
    teardown = installPluginHostRouting({
      lease: {
        getDriveTarget: () => {
          throw new Error("boom");
        },
        onChange: () => () => {},
      },
      registry: { onChange: () => () => {} },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePluginFrontend(PROJECT, "acme.x")).toEqual({
      kind: "none",
      reason: "lookup-failed",
    });
    warn.mockRestore();
  });

  it("tells listeners when a driver attaches or leaves", () => {
    const listener = vi.fn();
    const off = onPluginFrontendChange(listener);
    for (const notify of leaseListeners) notify();
    expect(listener).toHaveBeenCalled();
    off();
  });
});
