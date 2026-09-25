import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { LinkSession } from "../../link/session.js";
import { PLUGIN_ASSET_METHOD } from "../assetLinkMethods.js";
import { ClientPluginAssets } from "../ClientPluginAssets.js";
import {
  HostPluginAssetService,
  type HostPluginAssetEndpoint,
  type HostPluginAssetPlugin,
} from "../HostPluginAssetService.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const HOST = "studio-01";

/** A link session whose CALLs run the host's registered handlers in-process. */
function fakeLink() {
  const handlers = new Map<string, { schema: z.ZodType; handler: (p: unknown) => unknown }>();
  const closers: Array<() => void> = [];
  const session = {
    isOpen: true,
    registerCallHandler(method: string, schema: z.ZodType, handler: (p: unknown) => unknown) {
      handlers.set(method, { schema, handler });
      return () => handlers.delete(method);
    },
    onClose(cb: () => void) {
      closers.push(cb);
      return () => {};
    },
    async call(method: string, payload: unknown) {
      const entry = handlers.get(method);
      if (!entry) throw new Error(`no handler for ${method}`);
      return entry.handler(entry.schema.parse(payload));
    },
  };
  return { session, calls: vi.spyOn(session, "call") };
}

function hostEndpoint(projectId: string | null = PROJECT): HostPluginAssetEndpoint & {
  projectId: string | null;
} {
  return {
    endpointId: "s1:ep-1",
    clientEndpointId: "ep-1",
    clientId: "client-mbp",
    projectId,
    isClosed: () => false,
    onClose: () => ({ dispose: () => {} }),
  };
}

function setup(options: {
  plugins?: HostPluginAssetPlugin[];
  driving?: boolean;
  body?: string;
  endpointProject?: string | null;
  size?: number | null;
}) {
  let body = options.body ?? "export default 1;";
  let driving = options.driving ?? true;
  const fetchAsset = vi.fn(async (request: Request) => {
    expect(request.url).toMatch(/^plugin:\/\/pi-abc\//);
    return new Response(body, {
      status: 200,
      headers: { "Last-Modified": new Date(5_000).toUTCString() },
    });
  });
  const service = new HostPluginAssetService({
    rootForAuthority: (authority) => (authority === "pi-abc" ? "/plugins/graph" : undefined),
    loadedPlugins: async () =>
      options.plugins ?? [
        {
          instanceId: "acme.graph",
          projectId: null,
          dir: "/plugins/graph",
          remoteUnsupported: false,
        },
      ],
    isDriving: () => driving,
    fetchAsset,
    assetSize: async () => (options.size !== undefined ? options.size : body.length),
  });
  const { session, calls } = fakeLink();
  const endpoint = hostEndpoint(
    options.endpointProject === undefined ? PROJECT : options.endpointProject
  );
  service.attach(session as unknown as LinkSession, endpoint);
  const client = new ClientPluginAssets();
  client.noteEndpointOpened(HOST, { session, webContentsId: 9, endpointId: "ep-1" });
  return {
    client,
    calls,
    fetchAsset,
    endpoint,
    setBody: (next: string) => (body = next),
    setDriving: (next: boolean) => (driving = next),
  };
}

const request = {
  hostId: HOST,
  authority: "pi-abc",
  path: "__dtv-3/dist/view.js",
  method: "GET" as const,
};

describe("host plugin view assets", () => {
  it("serves a view bundle to the driving Shell and caches it by host, plugin and generation", async () => {
    const { client, calls } = setup({});
    const first = await client.proxy(request);
    expect(first.status).toBe(200);
    expect(new TextDecoder().decode(first.body!)).toBe("export default 1;");
    expect(first.lastModified).toBe(5_000);
    expect(client.size).toBe(1);

    // A second read revalidates: the host answers "unchanged" without bytes.
    const second = await client.proxy(request);
    expect(new TextDecoder().decode(second.body!)).toBe("export default 1;");
    const lastCall = calls.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(PLUGIN_ASSET_METHOD);
    expect(lastCall[1]).toMatchObject({ ifMatch: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("revokes the Shell's copy once the lease moves away", async () => {
    const { client, setDriving } = setup({});
    await client.proxy(request);
    setDriving(false);
    const refused = await client.proxy(request);
    expect(refused.status).toBe(403);
    expect(client.size).toBe(0);
  });

  it("drops a host's copies when the Shell's last endpoint on it closes", async () => {
    const { client } = setup({});
    await client.proxy(request);
    client.noteEndpointClosed(HOST, { endpointId: "ep-1" });
    expect(client.size).toBe(0);
    expect((await client.proxy(request)).status).toBe(503);
  });

  it("refreshes the copy when the bundle changed on the host", async () => {
    const { client, setBody } = setup({});
    await client.proxy(request);
    setBody("export default 2;");
    const next = await client.proxy(request);
    expect(new TextDecoder().decode(next.body!)).toBe("export default 2;");
    expect(client.size).toBe(1);
  });

  it("never serves another project's plugin, or a remote-unsupported one", async () => {
    const other = setup({
      plugins: [
        {
          instanceId: `project__${OTHER}__acme.graph`,
          projectId: OTHER,
          dir: "/plugins/graph",
          remoteUnsupported: false,
        },
      ],
    });
    expect((await other.client.proxy(request)).status).toBe(404);
    expect(other.fetchAsset).not.toHaveBeenCalled();

    const localOnly = setup({
      plugins: [
        {
          instanceId: "acme.graph",
          projectId: null,
          dir: "/plugins/graph",
          remoteUnsupported: true,
        },
      ],
    });
    expect((await localOnly.client.proxy(request)).status).toBe(404);
  });

  it("refuses an oversized asset, or one that isn't a file in the plugin, before reading it", async () => {
    const big = setup({ size: 9 * 1024 * 1024 });
    expect((await big.client.proxy(request)).status).toBe(413);
    expect(big.fetchAsset).not.toHaveBeenCalled();
    const missing = setup({ size: null });
    expect((await missing.client.proxy(request)).status).toBe(404);
    expect(missing.fetchAsset).not.toHaveBeenCalled();
  });

  it("serves nothing to an endpoint that shows no project, or for an unknown authority", async () => {
    const noProject = setup({ endpointProject: null });
    expect((await noProject.client.proxy(request)).status).toBe(404);
    const known = setup({});
    expect((await known.client.proxy({ ...request, authority: "pi-zzz" })).status).toBe(404);
  });
});

describe("containedAssetSize", () => {
  it("sizes a file inside the plugin root and nothing outside it", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { containedAssetSize } = await import("../HostPluginAssetService.js");
    const base = await realpath(await mkdtemp(join(tmpdir(), "asset-size-")));
    const root = join(base, "plugin");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "view.js"), "12345");
    await writeFile(join(base, "secret.txt"), "outside");
    await symlink(join(base, "secret.txt"), join(root, "dist", "leak.js"));
    try {
      expect(await containedAssetSize(root, "__dtv-4/dist/view.js")).toBe(5);
      expect(await containedAssetSize(root, "dist/leak.js")).toBeNull();
      expect(await containedAssetSize(root, "../secret.txt")).toBeNull();
      expect(await containedAssetSize(root, "dist")).toBeNull();
      expect(await containedAssetSize(root, "__dtv-x/dist/view.js")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
