import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
}));
const ipcMainMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    }),
    _emit: (channel: string, event: unknown, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    _listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    _reset: () => listeners.clear(),
  };
});
const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
}));
const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
}));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: windowRefMock.getWindowRegistry,
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));
vi.mock("../../store.js", () => ({
  store: storeMock,
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
  getPluginMenuItems: vi.fn(() => []),
}));
vi.mock("../forgeProviderRegistry.js", () => ({
  registerForgeProviders: vi.fn(),
  unregisterForgeProviders: vi.fn(),
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpls: vi.fn(),
  getForgeProviderImpl: vi.fn(),
  getRegisteredForgeProviders: vi.fn(() => []),
  clearForgeProviderImplRegistry: vi.fn(),
}));
// Mocked so unload-cascade tests can simulate a throwing decoration unregister
// without exercising the real (currently no-op) registry. Pre-existing tests
// transitively touched these via unloadPlugin but never asserted call counts.
vi.mock("../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));

// Mocked so MCP-server activation tests don't try to spawn real subprocesses
// or exercise the execa dynamic-import. The supervisor's wiring is verified
// here; PluginMcpSupervisor's own lifecycle is covered by its dedicated test.
const mockPluginMcpSupervisor = {
  start: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  shutdown: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  shutdownAll: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  callTool: vi.fn(),
  restart: vi.fn(),
  list: vi.fn(() => []),
  getStderr: vi.fn(() => ({ pluginId: "", serverId: "", lines: [], totalLines: 0 })),
};
vi.mock("../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => mockPluginMcpSupervisor,
}));

// Dev-mode hot-reload worker (#9304) is mocked so activation doesn't fork a
// real utilityProcess; tests assert routing/lifecycle via the captured spies.
const devWorkerMock = vi.hoisted(() => {
  interface DevWorkerOpts {
    pluginId: string;
    pluginDir: string;
    bundlePath: string;
    mode?: "dev" | "prod";
  }
  const instances: MockPluginDevWorkerHost[] = [];
  const bridges: MockPluginDevWorkerMainBridge[] = [];
  class MockPluginDevWorkerHost {
    opts: DevWorkerOpts;
    start = vi.fn(async () => undefined);
    dispose = vi.fn();
    isReady = (): boolean => true;
    on = vi.fn();
    off = vi.fn();
    constructor(opts: DevWorkerOpts) {
      this.opts = opts;
      instances.push(this);
    }
  }
  // The real worker forks a child that imports the plugin bundle, runs
  // `activate(host)`, and reports the outcome via `onActivationResult`. vitest
  // can't fork, so the mock bridge does that import + activate in-process
  // against the real host and drives the same callback — exercising
  // PluginService's activation/provenance wiring without a worker. (#10526)
  interface MockBridgeDeps {
    workerHost: { opts: DevWorkerOpts };
    host: unknown;
    onActivationResult?: (
      result: { ok: true } | { ok: false; error: string; stack?: string }
    ) => void;
  }
  class MockPluginDevWorkerMainBridge {
    deps: MockBridgeDeps;
    private cleanup: (() => void) | null = null;
    // Mirror the real bridge's getters; tests set these to simulate in-flight
    // main→worker invokes and worker→main host calls (e.g. an open prompt).
    pendingInvokeCount = 0;
    pendingHostCallCount = 0;
    waitForActivation = vi.fn(async () => {
      const bundlePath = this.deps.workerHost?.opts?.bundlePath;
      const onResult = this.deps.onActivationResult;
      if (!bundlePath) {
        onResult?.({ ok: true });
        return;
      }
      const { pathToFileURL } = await import("node:url");
      const { formatErrorMessage } = await import("../../../shared/utils/errorMessage.js");
      try {
        const mod = (await import(pathToFileURL(bundlePath).href)) as { activate?: unknown };
        if (typeof mod.activate === "function") {
          const result = await (mod.activate as (h: unknown) => unknown)(this.deps.host);
          if (typeof result === "function") this.cleanup = result as () => void;
        }
        onResult?.({ ok: true });
      } catch (err) {
        // Mirror the worker entry's failure shaping (formatErrorMessage + raw
        // Error stack) so provenance records match the real path.
        onResult?.({
          ok: false,
          error: formatErrorMessage(err, "activate() threw"),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    });
    dispose = vi.fn(() => {
      try {
        this.cleanup?.();
      } catch {
        // best-effort
      }
      this.cleanup = null;
    });
    constructor(deps: MockBridgeDeps) {
      this.deps = deps;
      bridges.push(this);
    }
  }
  return { instances, bridges, MockPluginDevWorkerHost, MockPluginDevWorkerMainBridge };
});
vi.mock("../plugin/PluginDevWorkerHost.js", () => ({
  PluginDevWorkerHost: devWorkerMock.MockPluginDevWorkerHost,
  CRASH_WINDOW_MS: 30 * 60 * 1000,
}));
vi.mock("../plugin/PluginDevWorkerMainBridge.js", () => ({
  PluginDevWorkerMainBridge: devWorkerMock.MockPluginDevWorkerMainBridge,
}));

import { getPluginManifestSchema, isPrivateOrLoopbackHostname } from "../../schemas/plugin.js";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "../../../shared/types/plugin.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginManifestSchema name validation", () => {
  const validBase = { version: "1.0.0" };
  const sixtyFourCharName = `a.${"b".repeat(62)}`; // 1 + 1 + 62 = 64 chars
  const sixtyFiveCharName = `a.${"b".repeat(63)}`; // 1 + 1 + 63 = 65 chars

  it.each([
    "acme.linear-context",
    "a.b",
    "daintreehq.dev-tools",
    "daintree-hq.my-cool-plugin",
    "acme.good-1",
    sixtyFourCharName,
  ])("accepts scoped name %j", (name) => {
    const result = getPluginManifestSchema(false).safeParse({ name, ...validBase });
    expect(result.success).toBe(true);
  });

  it.each([
    "linear-context",
    "test-plugin",
    "Acme.linear-context",
    "acme.Linear",
    "acme..tools",
    ".acme.tools",
    "acme.tools.",
    "acme.team.tools",
    "acme/tools",
    "acme_tools",
    "acme.-foo",
    "acme.foo-",
    "-acme.foo",
    "---.foo",
    "acme.---",
    " acme.foo",
    "acme.foo ",
    "acme.foo\n",
    sixtyFiveCharName,
    "",
  ])("rejects unscoped or malformed name %j", (name) => {
    const result = getPluginManifestSchema(false).safeParse({ name, ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejection includes an explanatory error message", () => {
    const result = getPluginManifestSchema(false).safeParse({ name: "bare-plugin", ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path[0] === "name");
      expect(nameIssue?.message).toContain("publisher.name");
    }
  });
});

describe("getPluginManifestSchema namespace lock", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects user plugin with daintree.* name", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintree.github-evil",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nsIssue = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      expect(nsIssue).toBeDefined();
      expect(nsIssue!.path).toEqual(["name"]);
    }
  });

  it("accepts builtin plugin with daintree.* name", () => {
    const result = getPluginManifestSchema(true).safeParse({
      ...validBase,
      name: "daintree.github",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with non-daintree.* scoped name", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "acme.daintree",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with daintreehq.* name (not the daintree. prefix)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintreehq.dev-tools",
    });
    expect(result.success).toBe(true);
  });

  it("rejects user plugin with bare daintree.foo name at schema level", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      name: "daintree.foo",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nsIssue = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      expect(nsIssue).toBeDefined();
    }
  });
});

describe("PluginManifestSchema capabilities field", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("defaults to empty array when omitted", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("accepts an empty capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, capabilities: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("accepts built-in capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read", "network:fetch", "agent:invoke"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([
        "fs:project-read",
        "network:fetch",
        "agent:invoke",
      ]);
    }
  });

  it("rejects custom (non-built-in) capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["custom:my-perm", "org.specific:do-thing"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects empty string in capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read", ""],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects whitespace-padded capability strings (no implicit trim)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["  fs:project-read  "],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects whitespace-only capability strings", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["   "],
    });
    expect(result.success).toBe(false);
  });

  it("rejects capability strings containing newline characters", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: ["fs:project-read\n"],
    });
    expect(result.success).toBe(false);
  });

  it('rejects stale "permissions" key because schema is strict', () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      permissions: ["fs:project-read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("BUILT_IN_PLUGIN_CAPABILITIES contains all documented capabilities", () => {
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:project-read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:project-write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:user-data-read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("fs:user-data-write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("network:fetch");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:invoke");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:register");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("agent:input");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("git:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("git:write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("clipboard:read");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("clipboard:write");
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toContain("shell:exec");
  });

  it("BUILT_IN_PLUGIN_CAPABILITIES has exactly 14 unique entries", () => {
    expect(BUILT_IN_PLUGIN_CAPABILITIES).toHaveLength(14);
    expect(new Set(BUILT_IN_PLUGIN_CAPABILITIES).size).toBe(14);
  });

  it("rejects null capabilities value", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects scalar (non-array) capabilities value", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: "git:read",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string elements in capabilities array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      capabilities: [1, "git:read"],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema scopes field", () => {
  const validBase = { name: "acme.scope-test", version: "1.0.0" };

  it("accepts manifest with no scopes field", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toBeUndefined();
    }
  });

  it("accepts empty scopes object (both buckets optional)", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, scopes: {} });
    expect(result.success).toBe(true);
  });

  it("accepts a valid network scope with one https URL", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: ["https://api.example.com/v2"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes?.network?.allowedUrls).toEqual(["https://api.example.com/v2"]);
    }
  });

  it.each([
    ["http://api.example.com", "scope_url_not_https"],
    ["ftp://api.example.com", "scope_url_not_https"],
    ["file:///etc/passwd", "scope_url_not_https"],
    ["https://localhost", "scope_url_private_target"],
    ["https://intranet", "scope_url_hostname_unqualified"],
    ["https://127.0.0.1", "scope_url_private_target"],
    ["https://[::1]", "scope_url_private_target"],
    ["https://[fe80::1]", "scope_url_private_target"],
    ["https://[fc00::1]", "scope_url_private_target"],
    ["https://[fd00::1]", "scope_url_private_target"],
    ["https://[::ffff:127.0.0.1]", "scope_url_private_target"],
    ["https://169.254.169.254", "scope_url_private_target"],
    ["https://10.0.0.1", "scope_url_private_target"],
    ["https://192.168.1.1", "scope_url_private_target"],
    ["https://172.16.0.1", "scope_url_private_target"],
    ["https://172.31.255.255", "scope_url_private_target"],
    ["https://0", "scope_url_private_target"],
    ["https://0.0.0.0", "scope_url_private_target"],
    ["https://localhost.", "scope_url_private_target"],
    ["https://LOCALHOST", "scope_url_private_target"],
    ["https://user:pass@example.com", "scope_url_has_credentials"],
    ["https://example.com/*", "scope_wildcard_rejected"],
    ["https://*.example.com", "scope_wildcard_rejected"],
    ["not-a-url", "scope_url_invalid"],
  ])("rejects network.allowedUrls entry %j with errorCode %s", (url, errorCode) => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: [url] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matching = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode === errorCode
      );
      expect(matching).toBeDefined();
    }
  });

  it("rejects empty allowedUrls array (min 1 required)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown key inside scopes (strict)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { networking: { allowedUrls: ["https://api.example.com"] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects unknown key inside scopes.network (strict)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: {
        network: {
          allowedUrls: ["https://api.example.com"],
          deniedUrls: ["https://evil.com"],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("accepts a valid fs scope with an absolute path", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: ["/home/user/projects"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes?.fs?.allowedPaths).toEqual(["/home/user/projects"]);
    }
  });

  it.each([
    ["relative/path", "scope_path_relative"],
    ["./relative", "scope_path_relative"],
    ["../escape", "scope_path_relative"],
    ["/home/user/../etc", "scope_path_traversal"],
    ["/home/user/**", "scope_wildcard_rejected"],
    ["/home/*/projects", "scope_wildcard_rejected"],
  ])("rejects fs.allowedPaths entry %j with errorCode %s", (entryPath, errorCode) => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: [entryPath] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matching = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode === errorCode
      );
      expect(matching).toBeDefined();
    }
  });

  it("rejects empty allowedPaths array (min 1 required)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects scalar (non-array) allowedUrls value", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: "https://api.example.com" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("isPrivateOrLoopbackHostname (download SSRF guard)", () => {
  // `new URL` keeps brackets on IPv6 literals, so feed the bracketed form the
  // install/checkForUpdate paths actually pass.
  it.each([
    "[::1]",
    "[fe80::1]",
    "[fc00::1]",
    "[fd00::1]",
    "[::ffff:127.0.0.1]",
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "0.0.0.0",
    "localhost",
    "localhost.",
  ])("blocks %j", (host) => {
    expect(isPrivateOrLoopbackHostname(host)).toBe(true);
  });

  it.each(["8.8.8.8", "[2606:4700::1111]", "203.0.113.5", "api.example.com"])(
    "allows public address %j",
    (host) => {
      expect(isPrivateOrLoopbackHostname(host)).toBe(false);
    }
  );
});

describe("PluginManifestSchema forgeProviders contribution", () => {
  const validBase = { name: "acme.forge", version: "1.0.0" };

  it("defaults contributes.forgeProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("defaults contributes.forgeProviders to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("accepts a fully specified forgeProviders entry", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        // settingsScopeRef / viewRefs are cross-validated against the manifest's
        // own settings/views (#10620), and each referenced view needs a matching
        // panel id — declare them so this stays a positive case.
        panels: [
          { id: "github-issues", name: "Issues", iconId: "eye", color: "#abc" },
          { id: "github-prs", name: "PRs", iconId: "eye", color: "#abc" },
        ],
        settings: [{ id: "github", type: "string", label: "GitHub" }],
        views: [
          { id: "github-issues", componentPath: "./issues.js", location: "panel" },
          { id: "github-prs", componentPath: "./prs.js", location: "panel" },
        ],
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues", "github-prs"],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([
        {
          id: "github",
          name: "GitHub",
          matches: ["github.com"],
          capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
          settingsScopeRef: "github",
          viewRefs: ["github-issues", "github-prs"],
        },
      ]);
    }
  });

  it("accepts a forgeProviders entry with only required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: ["github.com"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a forgeProviders entry with an empty matches array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a forgeProviders entry missing required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on a forgeProviders entry (strict schema)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh", name: "GitHub", matches: ["github.com"], unknownKey: true }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedIssue = result.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(unrecognizedIssue).toBeDefined();
    }
  });
});

describe("PluginManifestSchema fileDecorationProviders contribution", () => {
  const validBase = { name: "acme.decor", version: "1.0.0" };

  it("defaults contributes.fileDecorationProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema(false).safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("defaults to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("accepts a valid fileDecorationProviders entry", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "worktree-diff-review", scopes: ["worktree-diff:*"] }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([
        { id: "worktree-diff-review", scopes: ["worktree-diff:*"] },
      ]);
    }
  });

  it("rejects an entry with an empty scopes array", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d", scopes: [] }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing required fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on the entry (strict schema)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "d", scopes: ["s:*"], extra: true }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema contributes strict validation", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects unknown keys inside contributes (typo'd contribution-point names)", () => {
    // `commandz` is a deliberate typo of `commands` (#9281) — strict-mode
    // rejection of unknown keys catches plugin-author typos.
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        commandz: [{ id: "foo", title: "Foo", description: "bar", category: "test" }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedIssue = result.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(unrecognizedIssue).toBeDefined();
    }
  });

  it("accepts the stable views key inside contributes (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        // A view needs a matching panel id (view_panel_ref_unknown, #10620).
        panels: [{ id: "v", name: "V", iconId: "eye", color: "#abc" }],
        views: [{ id: "v", componentPath: "./v.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(1);
    }
  });

  it("accepts the stable mcpServers key inside contributes (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { mcpServers: [{ id: "svc", name: "Svc", command: "node" }] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.mcpServers).toHaveLength(1);
    }
  });

  it("migrates the deprecated experimental_views alias to the stable views key (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        // A view needs a matching panel id (view_panel_ref_unknown, #10620).
        panels: [{ id: "v", name: "V", iconId: "eye", color: "#abc" }],
        experimental_views: [{ id: "v", componentPath: "./v.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(1);
      // The deprecated key is stripped from the parsed output — no
      // `experimental_*` field survives in the frozen contract.
      expect("experimental_views" in result.data.contributes).toBe(false);
    }
  });

  it("migrates the deprecated experimental_mcpServers alias to the stable mcpServers key (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.mcpServers).toHaveLength(1);
      expect("experimental_mcpServers" in result.data.contributes).toBe(false);
    }
  });

  it("prefers the canonical key over a deprecated alias when both are present (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        // The surviving canonical view needs a matching panel id (#10620).
        panels: [{ id: "canonical", name: "Canonical", iconId: "eye", color: "#abc" }],
        views: [{ id: "canonical", componentPath: "./c.js", location: "panel" }],
        experimental_views: [{ id: "legacy", componentPath: "./l.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(1);
      expect(result.data.contributes.views[0]?.id).toBe("canonical");
      expect("experimental_views" in result.data.contributes).toBe(false);
    }
  });

  it("treats an explicit empty canonical array as canonical and does not adopt the alias (#10466)", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        views: [],
        experimental_views: [{ id: "legacy", componentPath: "./l.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(0);
    }
  });

  it("produces a clean error rather than throwing when contributes is not an object (#10466)", () => {
    for (const bad of [null, [], 42, "x"]) {
      const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: bad });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an arbitrary unknown key inside contributes", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: { unknownKey: true },
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty contributes object (no unknown keys, defaults populate)", () => {
    const result = getPluginManifestSchema(false).safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toEqual([]);
      expect(result.data.contributes.mcpServers).toEqual([]);
    }
  });

  it("accepts known contributes keys without extra keys", () => {
    const result = getPluginManifestSchema(false).safeParse({
      ...validBase,
      contributes: {
        panels: [],
        toolbarButtons: [],
      },
    });
    expect(result.success).toBe(true);
  });
});
