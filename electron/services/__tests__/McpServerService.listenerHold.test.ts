import fs from "node:fs/promises";
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A feature holds the loopback listener open, and its wakes accepted, with the
// MCP server off (#15999). Real sockets: what is unreachable is observed as a
// client sees it.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-listener-hold-${Math.random().toString(36).slice(2)}`
);

const storeState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = { ...actual, homedir: () => testHomeDir };
  return { ...mocked, default: mocked };
});

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  webContents: { fromId: vi.fn(() => undefined), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class BrowserWindow {},
  app: { getVersion: () => "0.0.0-test", getPath: () => testHomeDir },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      storeState.values.set(key, value);
    }),
  },
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock("../persistence/auditRingStore.js", () => ({
  auditRingStore: { readAll: () => [], writeAll: vi.fn() },
}));

vi.mock("../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    isValidPaneToken: () => false,
    getTierForToken: () => undefined,
  },
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => 0),
    onWake: vi.fn(() => () => {}),
  })),
}));

const pluginHost = vi.hoisted(() => ({
  hasPlugin: vi.fn((_id: string) => true),
  activatePlugin: vi.fn(async (_id: string) => {}),
}));

vi.mock("../PluginService.js", () => ({
  pluginService: {
    hasPlugin: (id: string) => pluginHost.hasPlugin(id),
    activatePlugin: (id: string) => pluginHost.activatePlugin(id),
    findAgentMcpServerSource: () => undefined,
  },
}));

import { McpServerService, type ListenerRoute } from "../McpServerService.js";
import { pluginMcpRoutePath } from "../pluginAgentMcp/types.js";
import type { LaneWake, LaneWakeOutcome } from "../mcp-server/terminalNotify.js";

const API_KEY = "orchestration-api-key";

const emptyRegistry = {
  all: () => [],
  focusOrder: () => [],
  getPrimary: () => null,
  getByWindowId: () => null,
  getByWebContentsId: () => null,
  size: 0,
};

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
});

interface Answer {
  status: number;
  body: string;
}

/** A raw request, so Host and Origin can be set as a browser or a rebinding page would. */
function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Connection: "close", ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        // An SSE or streamable answer stays open: the status is what is read.
        res.once("data", (chunk: string) => {
          body += chunk;
          res.destroy();
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function postMcp(port: number, token: string): Promise<Answer> {
  return request(port, "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: INIT_BODY,
  });
}

function featureRoute(path = "/mcp/feature") {
  const seen: string[] = [];
  const close = vi.fn();
  const route: ListenerRoute = {
    path,
    handle: async (_req, res, url) => {
      seen.push(url.pathname);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`held ${url.pathname}`);
    },
    close,
  };
  return { route, seen, close };
}

function recordingWake(id: string): { wake: LaneWake; outcomes: LaneWakeOutcome[] } {
  const outcomes: LaneWakeOutcome[] = [];
  return {
    outcomes,
    wake: {
      id,
      kind: "retired",
      retired: [{ hostName: "studio-01", count: 1 }],
      recheck: () => ({ kind: "ready" }),
      beforeType: () => true,
      report: (outcome) => outcomes.push(outcome),
    },
  };
}

describe("McpServerService listener holds (#15999)", () => {
  let service: McpServerService;

  function configure(enabled: boolean): void {
    storeState.values.set("mcpServer", {
      enabled,
      port: 0,
      apiKey: API_KEY,
      auditEnabled: false,
      auditMaxRecords: 500,
    });
  }

  beforeEach(async () => {
    storeState.values.clear();
    pluginHost.activatePlugin.mockClear();
    await fs.mkdir(testHomeDir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
  });

  afterEach(async () => {
    // Unconditionally: a listener open only for holds is not `isRunning`.
    await service.stop();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  /** Boot as the app does: start is skipped while off, but the registry is kept. */
  async function boot(enabled: boolean): Promise<void> {
    configure(enabled);
    await service.start(emptyRegistry as never);
  }

  it("serves a held route with the server off, and nothing else on the listener", async () => {
    await boot(false);
    const { route, seen } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const port = hold.port!;
    expect(port).toBeGreaterThan(0);

    expect(await request(port, "/mcp/feature")).toEqual({ status: 200, body: "held /mcp/feature" });
    expect((await request(port, "/mcp/feature/sub?x=1")).status).toBe(200);
    expect(seen).toEqual(["/mcp/feature", "/mcp/feature/sub"]);

    // The control surface and plugin routes answer as nothing there would,
    // whatever credential comes with them.
    expect((await postMcp(port, API_KEY)).status).toBe(404);
    expect((await postMcp(port, "unknown")).status).toBe(404);
    const auth = { Authorization: `Bearer ${API_KEY}` };
    expect((await request(port, "/sse", { headers: auth })).status).toBe(404);
    expect(
      (await request(port, "/messages?sessionId=x", { method: "POST", headers: auth })).status
    ).toBe(404);
    expect(
      (await request(port, pluginMcpRoutePath("acme.ledger"), { method: "POST", headers: auth }))
        .status
    ).toBe(404);
    expect(pluginHost.activatePlugin).not.toHaveBeenCalled();
    // A name that only starts like the held one is not under it.
    expect((await request(port, "/mcp/featurex")).status).toBe(404);
    expect(seen).toHaveLength(2);

    // Nothing reports a server that isn't on.
    expect(service.isRunning).toBe(false);
    expect(service.currentPort).toBeNull();
    expect(service.getStatus().port).toBeNull();
    expect(service.getRuntimeState()).toMatchObject({
      enabled: false,
      state: "disabled",
      port: null,
    });
    expect(await service.ensureReady()).toBe(false);
  });

  it("puts a held route behind the listener's shared Host and Origin checks", async () => {
    await boot(false);
    const { route, seen } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const port = hold.port!;

    expect(
      (await request(port, "/mcp/feature", { headers: { Host: `evil.example:${port}` } })).status
    ).toBe(403);
    expect(
      (await request(port, "/mcp/feature", { headers: { Origin: "https://evil.example" } })).status
    ).toBe(403);
    expect(
      (await request(port, "/mcp/feature", { headers: { Origin: `http://localhost:${port}` } }))
        .status
    ).toBe(200);
    expect(seen).toEqual(["/mcp/feature"]);
  });

  it("closes the listener when the last hold with the server off is released", async () => {
    await boot(false);
    const first = featureRoute("/mcp/first");
    const second = featureRoute("/mcp/second");
    const a = await service.holdListener("first", first.route);
    const b = await service.holdListener("second", second.route);
    const port = a.port!;
    expect(b.port).toBe(port);

    await a.release();
    await a.release();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(a.port).toBeNull();
    // The other hold still keeps it open; the released route is gone from it.
    expect((await request(port, "/mcp/second")).status).toBe(200);
    expect((await request(port, "/mcp/first")).status).toBe(404);

    await b.release();
    expect(b.port).toBeNull();
    await expect(request(port, "/mcp/second")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("keeps a held listener open when the server is turned off, with only the held route left", async () => {
    await boot(true);
    const { route } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const port = service.currentPort!;
    expect(hold.port).toBe(port);
    expect((await postMcp(port, API_KEY)).status).toBe(200);
    expect((await request(port, "/mcp/feature")).status).toBe(200);

    await service.setEnabled(false);
    expect(service.isRunning).toBe(false);
    expect(service.currentPort).toBeNull();
    expect(hold.port).toBe(port);
    expect((await request(port, "/mcp/feature")).status).toBe(200);
    expect((await postMcp(port, API_KEY)).status).toBe(404);
    expect(service.listActiveClients()).toEqual([]);

    await hold.release();
    await expect(request(port, "/mcp/feature")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("closes the listener as before when the server is turned off with no hold", async () => {
    await boot(true);
    const port = service.currentPort!;
    expect((await postMcp(port, API_KEY)).status).toBe(200);

    await service.setEnabled(false);
    expect(service.isRunning).toBe(false);
    await expect(postMcp(port, API_KEY)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("brings the control surface up on a held listener's port, and keeps it past the release", async () => {
    await boot(false);
    const { route } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const port = hold.port!;

    await service.setEnabled(true);
    expect(service.isRunning).toBe(true);
    expect(service.currentPort).toBe(port);
    expect((await postMcp(port, API_KEY)).status).toBe(200);
    expect((await request(port, "/mcp/feature")).status).toBe(200);

    await hold.release();
    expect(service.isRunning).toBe(true);
    expect((await postMcp(port, API_KEY)).status).toBe(200);
    // Released, the path is the control surface's again: no credential, no answer.
    expect((await request(port, "/mcp/feature")).status).toBe(401);
  });

  it("moves a held listener to a new port with the server off", async () => {
    await boot(false);
    const { route, close } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const before = hold.port!;

    // Bind a fixed free port, release it, then point the setting at it.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const target = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await service.setPort(target);
    expect(close).toHaveBeenCalledTimes(1);
    expect(hold.port).toBe(target);
    expect(service.isRunning).toBe(false);
    expect((await request(target, "/mcp/feature")).status).toBe(200);
    await expect(request(before, "/mcp/feature")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("ends every hold at shutdown", async () => {
    await boot(false);
    const { route, close } = featureRoute();
    const hold = await service.holdListener("feature", route);
    const port = hold.port!;

    await service.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(hold.port).toBeNull();
    await expect(request(port, "/mcp/feature")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(hold.release()).resolves.toBeUndefined();

    // A wake queued on a hold that shutdown ended is refused, not typed.
    const late = recordingWake("late-1");
    hold.queueWake({ key: "pane\u0000p", terminalId: "t-1" }, "project-1", late.wake);
    expect(late.outcomes).toEqual([{ kind: "unavailable", reason: "notices-off" }]);
  });

  it("refuses a path no hold may take, and a second hold on an id or path", async () => {
    await boot(false);
    for (const path of ["/mcp", "/mcp/plugin", "/mcp/a/b", "/feature", "/mcp/Feature"]) {
      await expect(service.holdListener("feature", featureRoute(path).route)).rejects.toThrow(
        "is not a path a listener hold can serve"
      );
    }
    await service.holdListener("feature", featureRoute("/mcp/one").route);
    await expect(service.holdListener("feature", featureRoute("/mcp/two").route)).rejects.toThrow(
      "already held"
    );
    await expect(service.holdListener("other", featureRoute("/mcp/one").route)).rejects.toThrow(
      "already serves /mcp/one"
    );
  });

  it("takes a hold's wakes with the server off, and refuses everyone else's", async () => {
    await boot(false);
    const hold = await service.holdListener("feature", featureRoute().route);
    const pane = { key: "pane\u0000principal-1", terminalId: "t-1" };

    // Past the server gate: here there is no terminal host to read the pane from.
    const scoped = recordingWake("decision-1");
    hold.queueWake(pane, "project-1", scoped.wake);
    expect(scoped.outcomes).toEqual([{ kind: "unavailable", reason: "unreadable" }]);

    const unscoped = recordingWake("task-1");
    service.queueLaneWake(
      { helpSessionId: "help-1", terminalId: "t-1", projectId: "project-1" },
      unscoped.wake
    );
    expect(unscoped.outcomes).toEqual([{ kind: "unavailable", reason: "notices-off" }]);

    await hold.release();
    const released = recordingWake("decision-2");
    hold.queueWake(pane, "project-1", released.wake);
    expect(released.outcomes).toEqual([{ kind: "unavailable", reason: "notices-off" }]);
  });
});
