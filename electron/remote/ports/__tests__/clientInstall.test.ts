import http from "node:http";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  gate: null as ((webContentsId: number, src: string) => boolean | null) | null,
  resolver: null as ((subdomain: string) => unknown) | null,
  sent: [] as unknown[],
}));

vi.mock("../../../window/ProjectViewHandlers.js", () => ({
  setRemoteWebviewSrcGate: (gate: typeof hooks.gate) => {
    hooks.gate = gate;
    return () => {
      hooks.gate = null;
    };
  },
}));
vi.mock("../../../ipc/handlers/devPreview.js", () => ({
  getDevPreviewProxyPort: () => 43000,
  setRemoteDevPreviewResolver: (resolver: typeof hooks.resolver) => {
    hooks.resolver = resolver;
    return () => {
      hooks.resolver = null;
    };
  },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
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
    expect(gate(9, "http://localhost:1/")).toBe(false);
    expect(gate(9, "http://dp-a-b.localhost:43000/")).toBe(true);
    // Any other *.localhost port is one of this machine's own services.
    expect(gate(9, "http://dp-a-b.localhost:3000/")).toBe(false);
    expect(gate(7, "http://localhost:1/")).toBeNull();
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
        hostIds: () => [HOST],
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
});
