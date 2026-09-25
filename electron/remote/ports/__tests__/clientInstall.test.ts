import http from "node:http";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  gate: null as ((webContentsId: number, src: string) => boolean | null) | null,
  isRemoteView: null as ((webContentsId: number) => boolean) | null,
  resolver: null as ((subdomain: string) => unknown) | null,
  localSubdomains: new Set<string>(),
  forwarded: null as ((call: unknown) => void) | null,
  sent: [] as unknown[],
}));

vi.mock("../../../window/ProjectViewHandlers.js", () => ({
  setRemoteWebviewSrcGate: (gate: typeof hooks.gate, isRemoteView: typeof hooks.isRemoteView) => {
    hooks.gate = gate;
    hooks.isRemoteView = isRemoteView;
    return () => {
      hooks.gate = null;
      hooks.isRemoteView = null;
    };
  },
}));
vi.mock("../../client/RemoteRouter.js", () => ({
  observeForwardedInvokes: (observer: (call: unknown) => void) => {
    hooks.forwarded = observer;
    return () => {
      hooks.forwarded = null;
    };
  },
}));
vi.mock("../../../ipc/handlers/devPreview.js", () => ({
  getDevPreviewProxyPort: () => 43000,
  resolveLocalDevPreviewUpstream: (subdomain: string) =>
    hooks.localSubdomains.has(subdomain)
      ? { kind: "ok", port: 5173, isHttps: false }
      : { kind: "unknown-subdomain" },
  setRemoteDevPreviewResolver: (resolver: typeof hooks.resolver) => {
    hooks.resolver = resolver;
    return () => {
      hooks.resolver = null;
    };
  },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: () => null,
  getAllAppWebContents: () => [
    { isDestroyed: () => false, send: (...args: unknown[]) => hooks.sent.push(args) },
  ],
}));

import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { _resetRemoteServicesForTest, getRemoteService } from "../../runtime.js";
import { installPortForwardClient } from "../clientInstall.js";
import { installHostPortService } from "../hostPorts.js";

const HOST = "studio-01";
let dir: string;
let host: LinkSession;
let client: LinkSession;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
  dir = await makeTempDir();
  ({ host, client } = await openSessionPair(dir));
  cleanups.push(
    installHostPortService({
      onSession(listener) {
        listener({ session: host });
        return () => {};
      },
    })
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.close("done");
  client.close("done");
  hooks.sent.length = 0;
  hooks.localSubdomains.clear();
  _resetRemoteServicesForTest();
  await removeTempDir(dir);
});

describe("installPortForwardClient", () => {
  it("serves portForwards and makes a forwarded port the host's localhost in that host's views", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const remotePort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as net.AddressInfo).port))
    );
    cleanups.push(() => upstream.close());

    let opened: ((hostId: string, info: { session: LinkSession }) => void) | null = null;
    const uninstall = installPortForwardClient({
      onEndpointOpened(listener) {
        opened = listener;
        return () => {
          opened = null;
        };
      },
      hostForView: (webContentsId) => (webContentsId === 9 ? HOST : null),
      projectForView: (webContentsId) =>
        webContentsId === 9 ? { hostId: HOST, projectId: "proj" } : null,
      isKnownHost: (hostId) => hostId === HOST,
      sshTargetFor: () => null,
      clientDir: dir,
    });
    cleanups.push(uninstall);
    const service = getRemoteService("portForwards")!;

    await expect(service.forward({ hostId: HOST, remotePort })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    opened!(HOST, { session: client });

    const forward = await service.forward({ hostId: HOST, remotePort });
    expect(service.list()).toHaveLength(1);
    expect(hooks.sent.at(-1)).toEqual([
      "port-forwards:event",
      { type: "changed", forwards: service.list() },
    ]);

    const gate = hooks.gate!;
    expect(gate(9, `http://localhost:${forward.localPort}/`)).toBe(true);
    expect(gate(9, `ws://127.0.0.1:${forward.localPort}/hmr`)).toBe(true);
    expect(gate(9, "http://localhost:1/")).toBe(false);
    expect(gate(9, "http://dp-proj-panel.localhost:43000/")).toBe(true);
    expect(gate(9, "ws://dp-proj-panel.localhost:43000/")).toBe(true);
    // Any other *.localhost port is one of this machine's own services.
    expect(gate(9, "http://dp-proj-panel.localhost:3000/")).toBe(false);
    // Another project's preview, on whichever host, is not this view's.
    expect(gate(9, "http://dp-other-panel.localhost:43000/")).toBe(false);
    expect(gate(7, "http://localhost:1/")).toBeNull();
    expect(hooks.isRemoteView!(9)).toBe(true);
    expect(hooks.isRemoteView!(7)).toBe(false);
    expect(hooks.resolver).toBeTypeOf("function");

    await uninstall();
    cleanups.pop();
    expect(getRemoteService("portForwards")).toBeUndefined();
    expect(hooks.gate).toBeNull();
    expect(hooks.resolver).toBeNull();
  });

  it("forwards from a host no local view is on, through its current session", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const remotePort = await new Promise<number>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as net.AddressInfo).port))
    );
    cleanups.push(() => upstream.close());

    let current: LinkSession | null = null;
    cleanups.push(
      installPortForwardClient({
        onEndpointOpened: () => () => {},
        hostForView: () => null,
        isKnownHost: (hostId) => hostId === HOST,
        sessionFor: (hostId) => (hostId === HOST ? current : null),
        sshTargetFor: () => null,
        clientDir: dir,
      })
    );
    const service = getRemoteService("portForwards")!;

    await expect(service.forward({ hostId: HOST, remotePort })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    current = client;
    const forward = await service.forward({ hostId: HOST, remotePort });
    expect(forward).toMatchObject({ hostId: HOST, remotePort });
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${forward.localPort}/`, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve(text));
        })
        .on("error", reject);
    });
    expect(body).toBe("ok");
  });

  it("gives a preview origin to the host and project whose view claimed it, and to no other", async () => {
    const OTHER = "studio-02";
    const views: Record<number, { hostId: string; projectId: string }> = {
      9: { hostId: HOST, projectId: "proj" },
      10: { hostId: OTHER, projectId: "proj" },
      11: { hostId: HOST, projectId: "proj" },
    };
    const hostOf = (webContentsId: number) => views[webContentsId]?.hostId ?? null;
    cleanups.push(
      installPortForwardClient({
        onEndpointOpened: () => () => {},
        hostForView: hostOf,
        projectForView: (webContentsId) => views[webContentsId] ?? null,
        isKnownHost: (hostId) => hostId === HOST || hostId === OTHER,
        sessionFor: (hostId) => (hostId === HOST || hostId === OTHER ? client : null),
        sshTargetFor: () => null,
        clientDir: dir,
      })
    );
    const gate = hooks.gate!;
    const origin = "http://dp-proj-panel.localhost:43000/";

    // Nobody has claimed it: the proxy asks no host at all.
    expect(hooks.resolver!("dp-proj-panel")).toBeNull();

    expect(gate(9, origin)).toBe(true);
    const lookup = hooks.resolver!("dp-proj-panel") as Promise<unknown> | null;
    expect(lookup).not.toBeNull();
    await expect(lookup).resolves.toBeNull();
    // Same project id on another host: the origin is taken while its owner shows it.
    expect(gate(10, origin)).toBe(false);
    // Another window on the owner's project may load it.
    expect(gate(11, origin)).toBe(true);

    // A preview this machine serves is a local project's, never a remote view's.
    hooks.localSubdomains.add("dp-proj-local");
    expect(gate(9, "http://dp-proj-local.localhost:43000/")).toBe(false);

    // Once no view of the owner shows the project any more, its host no longer answers for it
    // and another may claim it.
    delete views[9];
    delete views[11];
    expect(hooks.resolver!("dp-proj-panel")).toBeNull();
    expect(gate(10, origin)).toBe(true);
  });

  it("gives a preview to the host and project the Shell forwarded its creation for", async () => {
    const OTHER = "studio-02";
    const views: Record<number, { hostId: string; projectId: string }> = {
      9: { hostId: HOST, projectId: "proj" },
      10: { hostId: OTHER, projectId: "proj" },
    };
    cleanups.push(
      installPortForwardClient({
        onEndpointOpened: () => () => {},
        hostForView: (webContentsId) => views[webContentsId]?.hostId ?? null,
        projectForView: (webContentsId) => views[webContentsId] ?? null,
        isKnownHost: (hostId) => hostId === HOST || hostId === OTHER,
        sessionFor: (hostId) => (hostId === HOST || hostId === OTHER ? client : null),
        sshTargetFor: () => null,
        clientDir: dir,
      })
    );
    const gate = hooks.gate!;
    const origin = "http://dp-proj-panel.localhost:43000/";

    // Host B's view asks its host to start the preview: the Shell records B as the owner.
    hooks.forwarded!({
      hostId: OTHER,
      webContentsId: 10,
      hostProjectId: "proj",
      channel: "dev-preview:ensure",
      args: [{ panelId: "panel", projectId: "anything", cwd: "/x", devCommand: "npm run dev" }],
    });
    // Other channels and calls without a project register nothing.
    hooks.forwarded!({
      hostId: HOST,
      webContentsId: 9,
      hostProjectId: "proj",
      channel: "dev-preview:get-state",
      args: [{ panelId: "other" }],
    });

    // A later start of the same origin for another host changes nothing.
    hooks.forwarded!({
      hostId: HOST,
      webContentsId: 9,
      hostProjectId: "proj",
      channel: "dev-preview:ensure",
      args: [{ panelId: "panel" }],
    });
    // Host A's view shows a project with the same id, but the origin is registered to B.
    expect(gate(9, origin)).toBe(false);
    expect(gate(10, origin)).toBe(true);
    // A preview nobody registered still falls back to the view's own claim.
    expect(gate(9, "http://dp-proj-other.localhost:43000/")).toBe(true);
    // The proxy asks the registered owner even before any view has loaded it.
    delete views[10];
    const lookup = hooks.resolver!("dp-proj-panel") as Promise<unknown> | null;
    expect(lookup).not.toBeNull();
    await lookup;
  });
});
