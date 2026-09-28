import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

const { createPluginProtocolHandler, setRemotePluginAssetProxy } = await import("../protocols.js");
const { parseRemotePluginAssetPath, toRemotePluginViewUrl } =
  await import("../../../shared/types/pluginRemoteView.js");

let dir: string;
let offProxy: (() => void) | null = null;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-plugin-")));
  await fs.mkdir(path.join(dir, "dist"));
  await fs.writeFile(path.join(dir, "dist", "view.js"), "export default 'local';");
});

afterEach(async () => {
  offProxy?.();
  offProxy = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const handler = () =>
  createPluginProtocolHandler((authority) => (authority === "acme.graph" ? dir : undefined));

describe("remote plugin view URLs", () => {
  it("puts a view URL on its host and reads the host back", () => {
    const url = toRemotePluginViewUrl("plugin://pi-abc/__dtv-3/dist/view.js", "studio-01");
    expect(url).toBe("plugin://pi-abc/__dth-studio-01/__dtv-3/dist/view.js");
    expect(toRemotePluginViewUrl(url, "studio-01")).toBe(url);
    expect(toRemotePluginViewUrl("app://daintree/x.js", "studio-01")).toBe("app://daintree/x.js");
    expect(parseRemotePluginAssetPath(new URL(url).pathname)).toEqual({
      hostId: "studio-01",
      path: "__dtv-3/dist/view.js",
    });
    expect(parseRemotePluginAssetPath("/dist/view.js")).toBeNull();
    expect(parseRemotePluginAssetPath("/__dth-bad:id/x.js")).toBe("malformed");
    expect(parseRemotePluginAssetPath("/__dth-studio-01")).toBe("malformed");
  });
});

describe("plugin:// for a window attached to another machine", () => {
  it("fetches a host-scoped asset from its host, never from this machine's disk", async () => {
    const proxy = vi.fn(async () => ({
      status: 200,
      body: new TextEncoder().encode("export default 'host';"),
      lastModified: 5_000,
    }));
    offProxy = setRemotePluginAssetProxy(proxy);
    const response = await handler()(
      new Request("plugin://acme.graph/__dth-studio-01/__dtv-3/dist/view.js")
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export default 'host';");
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(response.headers.get("last-modified")).toBe(new Date(5_000).toUTCString());
    expect(proxy).toHaveBeenCalledWith({
      hostId: "studio-01",
      authority: "acme.graph",
      path: "__dtv-3/dist/view.js",
      method: "GET",
    });
  });

  it("answers 404 without a proxy, and passes a host's refusal through", async () => {
    const response = await handler()(
      new Request("plugin://acme.graph/__dth-studio-01/dist/view.js")
    );
    expect(response.status).toBe(404);
    offProxy = setRemotePluginAssetProxy(async () => ({ status: 403, body: null }));
    expect(
      (await handler()(new Request("plugin://acme.graph/__dth-studio-01/dist/view.js"))).status
    ).toBe(403);
  });

  it("never falls through to disk for a malformed host segment", async () => {
    const response = await handler()(new Request("plugin://acme.graph/__dth-/dist/view.js"));
    expect(response.status).toBe(404);
  });

  it("leaves a local asset exactly as it was", async () => {
    const response = await handler()(new Request("plugin://acme.graph/dist/view.js"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export default 'local';");
  });
});
