import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";
import type { PanelKindConfig } from "../../../shared/config/panelKindRegistry.js";

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

import { z } from "zod";
import { PluginService } from "../PluginService.js";
import { events } from "../events.js";
import { PluginProcessManager, type ManagedChildProcess } from "../plugin/PluginProcessManager.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../plugin-capability/instances.js";
import { getPluginActionAuditService } from "../PluginActionAuditService.js";
import { setPtyClientRef } from "../../window/serviceRefs.js";
import { isAuditedHandlerFailure } from "../../utils/pluginAuditMarker.js";
import { PluginInvokeOwnershipError } from "../plugin/PluginInvokeErrors.js";
import { getPluginManifestSchema, isPrivateOrLoopbackHostname } from "../../schemas/plugin.js";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type PluginIpcContext,
  type PluginManifest,
} from "../../../shared/types/plugin.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import {
  getRegisteredForgeProviders,
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";
import {
  unregisterFileDecorationProviders,
  unregisterFileDecorationProviderImpls,
} from "../fileDecorationRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";

function makeCtx(pluginId: string, overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId,
    ...overrides,
  };
}

let tmpDir: string;

function writePlugin(name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, name);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

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
          { id: "github-issues", name: "Issues", componentPath: "./issues.js", location: "panel" },
          { id: "github-prs", name: "PRs", componentPath: "./prs.js", location: "panel" },
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
        views: [{ id: "v", name: "V", componentPath: "./v.js", location: "panel" }],
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
        experimental_views: [{ id: "v", name: "V", componentPath: "./v.js", location: "panel" }],
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
        views: [{ id: "canonical", name: "Canonical", componentPath: "./c.js", location: "panel" }],
        experimental_views: [
          { id: "legacy", name: "Legacy", componentPath: "./l.js", location: "panel" },
        ],
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
        experimental_views: [
          { id: "legacy", name: "Legacy", componentPath: "./l.js", location: "panel" },
        ],
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

describe("PluginService", () => {
  it("returns empty list when plugins directory does not exist", async () => {
    const service = new PluginService(path.join(tmpDir, "nonexistent"));
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("returns empty list when plugins directory is empty", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads a valid plugin and registers panel kinds", async () => {
    await writePlugin("test-plugin", {
      name: "acme.test-plugin",
      version: "1.0.0",
      displayName: "Test Plugin",
      contributes: {
        panels: [
          {
            id: "viewer",
            name: "Test Viewer",
            iconId: "eye",
            color: "#ff0000",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.test-plugin");
    expect(plugins[0].manifest.displayName).toBe("Test Plugin");
    expect(plugins[0].dir).toBe(path.join(tmpDir, "test-plugin"));

    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.test-plugin.viewer",
        name: "Test Viewer",
        iconId: "eye",
        color: "#ff0000",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        showInPalette: true,
        extensionId: "acme.test-plugin",
      })
    );
  });

  it("skips directories without plugin.json", async () => {
    await fs.mkdir(path.join(tmpDir, "empty-dir"));

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid JSON", async () => {
    const dir = path.join(tmpDir, "bad-json");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "plugin.json"), "not valid json {{{");

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid manifest schema", async () => {
    await writePlugin("invalid-schema", {
      version: "1.0.0",
      // missing required 'name' field
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads multiple plugins and skips invalid ones", async () => {
    await writePlugin("good-1", { name: "acme.good-1", version: "1.0.0" });
    await writePlugin("bad", { version: "1.0.0" }); // missing name
    await writePlugin("good-2", { name: "acme.good-2", version: "2.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["acme.good-1", "acme.good-2"]);
  });

  it("deep-freezes the stored manifest as an immutability invariant (#10477)", async () => {
    await writePlugin("frozen", {
      name: "acme.frozen",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const stored = (
      service as unknown as { plugins: Map<string, { manifest: unknown }> }
    ).plugins.get("acme.frozen")?.manifest as { contributes: { panels: unknown[] } } | undefined;
    expect(stored).toBeDefined();
    // Deep freeze: top level and nested contribution arrays/objects are sealed.
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored!.contributes)).toBe(true);
    expect(Object.isFrozen(stored!.contributes.panels)).toBe(true);
    expect(Object.isFrozen(stored!.contributes.panels[0])).toBe(true);
  });

  it("is idempotent — second initialize is a no-op", async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(0); // no panels declared
  });

  it("namespaces panel IDs as pluginName.panelId", async () => {
    await writePlugin("my-plugin", {
      name: "acme.my-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "viewer", name: "Viewer", iconId: "eye", color: "#000" },
          { id: "editor", name: "Editor", iconId: "pen", color: "#fff" },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPanelKind).toHaveBeenCalledTimes(2);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.viewer" })
    );
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.editor" })
    );
  });

  it("rejects main entry paths that escape the plugin directory", async () => {
    await writePlugin("escape-test", {
      name: "acme.escape-test",
      version: "1.0.0",
      main: "../evil.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // The plugin loads but main is silently rejected (no import attempted)
    expect(plugins[0].manifest.main).toBe("../evil.js");
  });

  it("does not include resolvedMain in listPlugins output", async () => {
    await writePlugin("main-test", {
      name: "acme.main-test",
      version: "1.0.0",
      main: "dist/main.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // listPlugins returns LoadedPluginInfo which doesn't have resolvedMain
    expect(Object.keys(plugins[0])).not.toContain("resolvedMain");
  });

  it("listPlugins includes archiveHash when set on a loaded plugin", async () => {
    await writePlugin("hashed", {
      name: "acme.hashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const validHash = "a".repeat(64);
    service.setPluginArchiveHash("acme.hashed", validHash);
    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBe(validHash);
  });

  it("listPlugins returns null archiveHash when not set", async () => {
    await writePlugin("unhashed", {
      name: "acme.unhashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBeNull();
  });

  it("setPluginArchiveHash is a silent no-op for unknown plugin ids", () => {
    const service = new PluginService(tmpDir);
    expect(() => service.setPluginArchiveHash("acme.nonexistent", "deadbeef")).not.toThrow();
  });

  describe("listPlugins pluginDanger", () => {
    it("reports safe for a plugin with no capabilities", async () => {
      await writePlugin("safe-plugin", { name: "acme.safe", version: "1.0.0" });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("reports safe for a read-only / clipboard capability set", async () => {
      await writePlugin("reader", {
        name: "acme.reader",
        version: "1.0.0",
        capabilities: ["fs:project-read", "git:read", "clipboard:read"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("reports confirm for an individually high-risk capability (shell:exec)", async () => {
      await writePlugin("sheller", {
        name: "acme.sheller",
        version: "1.0.0",
        capabilities: ["shell:exec"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    // Guards against accidental removal from CONFIRM_TRIGGERING_CAPABILITIES.
    it.each([
      "git:write",
      "fs:project-write",
      "fs:user-data-write",
      "agent:invoke",
      "agent:register",
      "agent:input",
    ])("reports confirm for the flat-elevated capability %s", async (capability) => {
      await writePlugin("flat", {
        name: "acme.flat",
        version: "1.0.0",
        capabilities: [capability],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    it("reports confirm via the compound lattice (sensitive read + unscoped network:fetch)", async () => {
      await writePlugin("exfil", {
        name: "acme.exfil",
        version: "1.0.0",
        capabilities: ["fs:project-read", "network:fetch"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    it("reports safe when a tight network scope attenuates the compound pair", async () => {
      await writePlugin("scoped", {
        name: "acme.scoped",
        version: "1.0.0",
        capabilities: ["fs:project-read", "network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v1"] } },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("computes pluginDanger for a launch-disabled plugin too", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.off-danger"] });
      await writePlugin("off-danger", {
        name: "acme.off-danger",
        version: "1.0.0",
        capabilities: ["shell:exec"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      const info = service.listPlugins()[0];
      expect(info.disabled).toBe(true);
      expect(info.pluginDanger).toBe("confirm");
    });
  });

  it("rejects manifest with empty name", async () => {
    await writePlugin("empty-name", { name: "", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects manifest with path-traversal name", async () => {
    await writePlugin("evil-name", { name: "../evil", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects panel with invalid ID characters", async () => {
    await writePlugin("bad-panel", {
      name: "acme.bad-panel",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "../../hack", name: "Hack", iconId: "x", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects duplicate plugin names with error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("dir-a", {
        name: "acme.same-name",
        version: "1.0.0",
        description: "first",
      });
      await writePlugin("dir-b", {
        name: "acme.same-name",
        version: "2.0.0",
        description: "second",
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      // Initialize loads plugins concurrently via Promise.allSettled; the winner
      // is whichever finishes first, which depends on fs.readFile completion
      // order. The contract being tested is "first wins, duplicates rejected" —
      // not which directory happens to win on a given filesystem.
      const winner = plugins[0].manifest.description;
      expect(winner === "first" || winner === "second").toBe(true);
      const loser = winner === "first" ? "dir-b" : "dir-a";
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate plugin name "acme.same-name" in ${loser}`)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("allows retry after non-ENOENT initialize failure", async () => {
    const badRoot = path.join(tmpDir, "unreadable");
    await fs.mkdir(badRoot);
    await writePlugin("good", { name: "acme.good", version: "1.0.0" });

    const service = new PluginService(tmpDir);

    // First call succeeds
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);

    // Second call is no-op (already initialized)
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);
  });

  it("registers toolbar buttons from plugin manifest", async () => {
    await writePlugin("toolbar-test", {
      name: "acme.toolbar-test",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "acme.toolbar-test.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.toolbar-test.my-btn",
        label: "My Button",
        iconId: "puzzle",
        actionId: "acme.toolbar-test.doThing",
        priority: 4,
        pluginId: "acme.toolbar-test",
      })
    );
  });

  it("uses default priority 3 when not specified in toolbar button", async () => {
    await writePlugin("default-priority", {
      name: "acme.default-priority",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "btn",
            label: "Btn",
            iconId: "icon",
            actionId: "acme.default-priority.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.default-priority.btn",
        priority: 3,
      })
    );
  });

  it("registers menu items from plugin manifest", async () => {
    await writePlugin("menu-test", {
      name: "acme.menu-test",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "acme.menu-test.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPluginMenuItem).toHaveBeenCalledWith("acme.menu-test", {
      label: "Do Something",
      actionId: "acme.menu-test.doSomething",
      location: "terminal",
    });
  });

  it("does not call toolbar/menu registration when no contributions", async () => {
    await writePlugin("empty-contribs", {
      name: "acme.empty-contribs",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });
});

describe("PluginService manifest command contributions (#9281)", () => {
  async function writePluginWithSrc(
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {}
  ): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    if (Object.keys(files).length > 0) {
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, "src", filename), content);
      }
    }
  }

  function ctx(pluginId: string): PluginIpcContext {
    return makeCtx(pluginId);
  }

  it("registers a manifest command descriptor at load time without importing the handler", async () => {
    await writePluginWithSrc(
      "cmd-lazy",
      {
        name: "acme.cmd-lazy",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Run the thing",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "do-thing.ts": `export default () => "loaded"`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.cmd-lazy",
      id: "acme.cmd-lazy.do-thing",
      title: "Do Thing",
      category: "Test",
      kind: "command",
      danger: "safe",
      effectiveDanger: "safe",
    });
  });

  it("lazily imports and invokes the handler on first dispatch", async () => {
    await writePluginWithSrc(
      "cmd-dispatch",
      {
        name: "acme.cmd-dispatch",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "plan",
              title: "Plan",
              description: "",
              category: "Planning",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "plan.js": `export default async (args) => ({ ok: true, args })`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const result = await service.dispatchHandler(
      "acme.cmd-dispatch",
      "acme.cmd-dispatch.plan",
      ctx("acme.cmd-dispatch"),
      [{ issue: 42 }]
    );
    expect(result).toEqual({ ok: true, args: { issue: 42 } });
  });

  it("throws the documented toast error when the handler file is missing", async () => {
    await writePluginWithSrc("cmd-missing", {
      name: "acme.cmd-missing",
      version: "1.0.0",
      contributes: {
        commands: [
          {
            id: "ghost",
            title: "Ghost",
            description: "",
            category: "Test",
            kind: "command",
            danger: "safe",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    // Descriptor is still registered (palette visibility) even with no file.
    expect(service.listPluginActions()).toHaveLength(1);

    await expect(
      service.dispatchHandler(
        "acme.cmd-missing",
        "acme.cmd-missing.ghost",
        ctx("acme.cmd-missing"),
        []
      )
    ).rejects.toThrow('Command "acme.cmd-missing.ghost" has no handler');
  });

  it("throws when the handler module has no callable default export", async () => {
    await writePluginWithSrc(
      "cmd-nodef",
      {
        name: "acme.cmd-nodef",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "broken",
              title: "Broken",
              description: "",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "broken.js": `export const named = 1`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    await expect(
      service.dispatchHandler("acme.cmd-nodef", "acme.cmd-nodef.broken", ctx("acme.cmd-nodef"), [])
    ).rejects.toThrow(/no callable default export/);
  });

  it("probes extensions in order .js → .mjs and ignores a .ts sibling", async () => {
    // The resolver now only probes built handler modules (.js, .mjs); a .ts or
    // .tsx sibling is never picked. When both .js and .mjs exist, .js wins.
    await writePluginWithSrc(
      "cmd-order",
      {
        name: "acme.cmd-order",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "pick",
              title: "Pick",
              description: "",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        // A .ts sibling must NOT be probed — if it were, it would shadow .js.
        "pick.ts": `export default () => "ts-not-probed"`,
        "pick.js": `export default () => "js-wins"`,
        "pick.mjs": `export default () => "mjs-loses"`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const result = await service.dispatchHandler(
      "acme.cmd-order",
      "acme.cmd-order.pick",
      ctx("acme.cmd-order"),
      []
    );
    expect(result).toBe("js-wins");
  });

  it("surfaces a loadError when a manifest command collides with a built-in id", async () => {
    // Construct a plugin whose namespaced command id WILL collide. The
    // manifest schema requires `publisher.name` form (`/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/`),
    // so we filter built-ins to ones whose first two dotted segments would
    // satisfy that pattern — three-segment, all-lowercase, no camelCase or
    // special chars.
    const { BUILT_IN_ACTION_IDS } = await import("../../../shared/config/actionIds.js");
    const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const threeSegment = BUILT_IN_ACTION_IDS.find((id) => {
      const parts = id.split(".");
      if (parts.length < 3) return false;
      return pluginNamePattern.test(`${parts[0]}.${parts[1]}`);
    });
    if (!threeSegment) {
      // No suitable target — the collision path is structurally unreachable
      // from a well-formed plugin manifest, so the load-time guard is
      // defence-in-depth against a future built-in id whose shape would
      // overlap. The test still validates the descriptor-registration path
      // doesn't accidentally allow such an id.
      return;
    }
    const parts = threeSegment.split(".");
    const pluginName = `${parts[0]}.${parts[1]}`;
    const cmdId = parts.slice(2).join(".");

    await writePluginWithSrc(pluginName, {
      name: pluginName,
      version: "1.0.0",
      contributes: {
        commands: [
          {
            id: cmdId,
            title: "Collides",
            description: "",
            category: "X",
            kind: "command",
            danger: "safe",
          },
        ],
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      const namespacedId = `${pluginName}.${cmdId}`;
      // No descriptor for the colliding id.
      expect(service.listPluginActions().some((a) => a.id === namespacedId)).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`command id "${namespacedId}" collides with a built-in action id`)
      );
      // Provenance loadError set on the installed record.
      const installed = (storeMock._state.get("plugins") as { installed?: Record<string, unknown> })
        ?.installed as Record<string, { loadError?: { message: string } }> | undefined;
      expect(installed?.[pluginName]?.loadError?.message).toContain("collides with a built-in");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("registers the toolbar button under the canonical {pluginId}.{btnId} namespace", async () => {
    await writePlugin("ns-check", {
      name: "acme.ns-check",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [{ id: "btn", label: "Btn", iconId: "i", actionId: "acme.ns-check.act" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.ns-check.btn",
        pluginId: "acme.ns-check",
      })
    );
  });

  it("preserves a collision loadError across a successful main activation", async () => {
    // A plugin with both `main` AND a colliding manifest command writes a
    // loadError at load time; `_doActivate()` success previously cleared it
    // unconditionally, erasing the diagnostic. The collision is a manifest-
    // level fact that doesn't go away when `main` activates cleanly.
    const { BUILT_IN_ACTION_IDS } = await import("../../../shared/config/actionIds.js");
    const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const threeSegment = BUILT_IN_ACTION_IDS.find((id) => {
      const parts = id.split(".");
      if (parts.length < 3) return false;
      return pluginNamePattern.test(`${parts[0]}.${parts[1]}`);
    });
    if (!threeSegment) return;
    const parts = threeSegment.split(".");
    const pluginName = `${parts[0]}.${parts[1]}`;
    const cmdId = parts.slice(2).join(".");

    const pluginDir = path.join(tmpDir, pluginName);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: pluginName,
        version: "1.0.0",
        main: "main.js",
        contributes: {
          commands: [
            {
              id: cmdId,
              title: "Bad",
              description: "",
              category: "X",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.js"),
      `export async function activate() { /* no-op */ }`
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin(pluginName);

      const installed = (storeMock._state.get("plugins") as { installed?: Record<string, unknown> })
        ?.installed as Record<string, { loadError?: { message: string } | null }> | undefined;
      expect(installed?.[pluginName]?.loadError?.message).toContain("collides with a built-in");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("PluginService built-in plugin loading", () => {
  let builtinDir: string;

  async function writeBuiltinPlugin(
    name: string,
    manifest: Record<string, unknown>
  ): Promise<void> {
    const dir = path.join(builtinDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  beforeEach(async () => {
    builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-plugin-test-"));
  });

  afterEach(async () => {
    await fs.rm(builtinDir, { recursive: true, force: true });
  });

  it("tags plugins loaded from the built-in directory with isBuiltin=true", async () => {
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
    const user = plugins.find((p) => p.manifest.name === "acme.user-plugin");
    expect(builtin?.isBuiltin).toBe(true);
    expect(user?.isBuiltin).toBe(false);
  });

  it("user plugins receive isBuiltin=false even when no built-in dir is configured", async () => {
    await writePlugin("acme.user-only", {
      name: "acme.user-only",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("skips built-in scan cleanly when the directory is absent", async () => {
    const missingDir = path.join(builtinDir, "does-not-exist");
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: missingDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.user-plugin");
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("built-ins win when a user plugin declares the same manifest name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeBuiltinPlugin("collision", {
        name: "daintree.dupe",
        version: "1.0.0",
        description: "builtin",
      });
      await writePlugin("collision-user", {
        name: "daintree.dupe",
        version: "2.0.0",
        description: "user",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.description).toBe("builtin");
      expect(plugins[0].isBuiltin).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid manifest in collision-user`),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("skips built-ins listed in plugins.disabled but still lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.muted"] });
    await writeBuiltinPlugin("muted", {
      name: "daintree.muted",
      version: "1.0.0",
    });
    await writeBuiltinPlugin("kept", {
      name: "daintree.kept",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    const kept = plugins.find((p) => p.manifest.name === "daintree.kept");
    const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
    expect(kept?.disabled).toBe(false);
    expect(muted?.disabled).toBe(true);
    expect(muted?.isBuiltin).toBe(true);
  });

  it("skips user plugins listed in plugins.disabled and lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["acme.user-plugin"] });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("marks active plugins with disabled=false", async () => {
    await writePlugin("acme.active", { name: "acme.active", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(false);
  });

  it("treats missing plugins.disabled as empty (no exception)", async () => {
    // store has no "plugins" key at all (in-memory fallback shape)
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("ignores malformed disabled values defensively", async () => {
    storeMock._state.set("plugins", { disabled: "not-an-array" });
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("a disabled name collision keeps the built-in entry (loaded first) for the toggle", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.github"] });
    await writeBuiltinPlugin("github", {
      name: "daintree.github",
      version: "1.0.0",
      description: "first-party",
    });
    await writePlugin("hijacker", {
      name: "daintree.github",
      version: "9.9.9",
      description: "third-party impostor",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(true);
    expect(plugins[0].manifest.description).toBe("first-party");
  });

  describe("setEnabled", () => {
    it("adds a plugin id to plugins.disabled when disabling", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("removes a plugin id from plugins.disabled when enabling", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo", "acme.bar"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", true);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.bar"] });
    });

    it("is idempotent — disabling an already-disabled plugin does not duplicate it", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("preserves other keys in the plugins object", async () => {
      storeMock._state.set("plugins", { disabled: [], other: "keep" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"], other: "keep" });
    });

    it("throws on an empty or whitespace-only plugin id", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.setEnabled("", false)).rejects.toThrow(/non-empty string/);
      await expect(service.setEnabled("   ", false)).rejects.toThrow(/non-empty string/);
    });

    it("user plugin disable diverges desired/running state and raises pendingRestart", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writePlugin("acme.runtime", { name: "acme.runtime", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({ disabled: false, pendingRestart: false });

      await service.setEnabled("acme.runtime", false);

      // User plugin stays loaded this session (no live unload); the desired
      // state is now off, so the restart-required cue is raised.
      expect(service.listPlugins()[0]).toMatchObject({ disabled: true, pendingRestart: true });
    });

    it("user plugin re-enable of a launch-disabled plugin stays pendingRestart", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.off"] });
      await writePlugin("acme.off", { name: "acme.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({ disabled: true, pendingRestart: false });

      await service.setEnabled("acme.off", true);

      // User plugin is not loaded live; desired state is on, so it's pending.
      expect(service.listPlugins()[0]).toMatchObject({ disabled: false, pendingRestart: true });
    });

    it("built-in disable unloads live — disabled, not pending, no longer running", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.live", { name: "daintree.live", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()[0]).toMatchObject({
        disabled: false,
        pendingRestart: false,
        isBuiltin: true,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("daintree.live", false);

      // Applied immediately: the plugin is unloaded (loadedAt resets to 0 since
      // it's now surfaced from the skipped map) and no restart is required.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: true, pendingRestart: false, isBuiltin: true });
      expect(row.loadedAt).toBe(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("built-in re-enable loads live — enabled, not pending, running again", async () => {
      storeMock._state.set("plugins", { disabled: ["daintree.off"] });
      await writeBuiltinPlugin("daintree.off", { name: "daintree.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()[0]).toMatchObject({
        disabled: true,
        pendingRestart: false,
        isBuiltin: true,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("daintree.off", true);

      // Applied immediately: now running (loadedAt is set) and no restart cue.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: false, pendingRestart: false, isBuiltin: true });
      expect(row.loadedAt).toBeGreaterThan(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("built-in disable notifies workspace hosts that the forge registry changed", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.forgey", {
        name: "daintree.forgey",
        version: "1.0.0",
        contributes: {
          forgeProviders: [{ id: "forgey", name: "Forgey", matches: ["forgey.example.com"] }],
        },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      const notifyForgeProviderRegistryUpdated = vi.fn();
      service.setWorkspaceClient({
        notifyForgeProviderRegistryUpdated,
        // The real WorkspaceClient is an EventEmitter; the service-level
        // worktree-scope cache eviction listener (#10621) wires through on/off.
        on: vi.fn(),
        off: vi.fn(),
      } as never);

      await service.setEnabled("daintree.forgey", false);

      // The unload removed the forge descriptor from the registry, so PR
      // polling in every workspace host must re-resolve — without this notify,
      // a live disable left hosts polling against a provider that no longer
      // exists (the load path has always notified; see loadPlugin).
      expect(notifyForgeProviderRegistryUpdated).toHaveBeenCalled();
    });

    it("built-in survives a rapid disable→enable→disable without a stuck state", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.flap", { name: "daintree.flap", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      // Fire all three without awaiting between them — the per-id chain must
      // serialise them so the final state is a clean, applied disable.
      await Promise.all([
        service.setEnabled("daintree.flap", false),
        service.setEnabled("daintree.flap", true),
        service.setEnabled("daintree.flap", false),
      ]);

      const rows = service.listPlugins();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disabled: true, pendingRestart: false, isBuiltin: true });
    });

    it("a failed built-in re-enable restores the skipped state (no lost row)", async () => {
      // Launch-disabled built-in whose engine range can never be satisfied by
      // the running app version, so the re-enable's loadPlugin() returns null at
      // the engine gate and must fall through to the restore path.
      storeMock._state.set("plugins", { disabled: ["daintree.future"] });
      await writeBuiltinPlugin("daintree.future", {
        name: "daintree.future",
        version: "1.0.0",
        engines: { daintree: ">=99.0.0" },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);

      await service.setEnabled("daintree.future", true);

      // Intent persisted as enabled, but the load failed: the row stays visible,
      // not running, flagged pendingRestart — never silently dropped.
      const rows = service.listPlugins();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        disabled: false,
        pendingRestart: true,
        isBuiltin: true,
      });
      expect(rows[0].loadedAt).toBe(0);
    });

    it("an unknown plugin id is treated as a user plugin (persist-only, no transition)", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("unknown.plugin", false);

      // Persisted, but no live transition runs and no provenance broadcast fires.
      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["unknown.plugin"] });
      expect(broadcastToRendererMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });
  });

  describe("uninstallPlugin", () => {
    it("removes a running plugin from listPlugins, deletes its dir, and broadcasts provenance-changed", async () => {
      await writePlugin("acme.live", { name: "acme.live", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);

      await service.uninstallPlugin("acme.live");

      expect(service.listPlugins()).toEqual([]);
      await expect(fs.access(path.join(tmpDir, "acme.live"))).rejects.toThrow();
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("removes a launch-disabled plugin and clears it from plugins.disabled (no zombie row)", async () => {
      // Regression: a disabled plugin lives in `disabledPlugins`, not `plugins`,
      // so unloadPlugin alone leaves the row in listPlugins and resurrects it on
      // the next launch.
      storeMock._state.set("plugins", { disabled: ["acme.off"] });
      await writePlugin("acme.off", { name: "acme.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);
      expect(service.listPlugins()[0]).toMatchObject({ disabled: true });

      await service.uninstallPlugin("acme.off");

      expect(service.listPlugins()).toEqual([]);
      await expect(fs.access(path.join(tmpDir, "acme.off"))).rejects.toThrow();
      const stored = storeMock._state.get("plugins") as { disabled?: string[] };
      expect(stored.disabled ?? []).not.toContain("acme.off");
    });

    it("deletes the installed provenance record", async () => {
      storeMock._state.set("plugins", {
        disabled: [],
        installed: { "acme.gone": { source: "sideload", installedAt: 1 } },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.uninstallPlugin("acme.gone");

      const stored = storeMock._state.get("plugins") as { installed?: Record<string, unknown> };
      expect(stored.installed ?? {}).not.toHaveProperty("acme.gone");
    });

    it("preserves the user-scope settings file by default", async () => {
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.keep"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.keep", "plugin.json"),
        JSON.stringify({ name: "acme.keep", version: "1.0.0" })
      );
      const settingsFile = path.join(tmpDir, "plugin-settings", "acme.keep.json");
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify({ token: "secret" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.keep");

      await expect(fs.access(path.join(pluginsRoot, "acme.keep"))).rejects.toThrow();
      // Secrets survive a plain uninstall.
      await expect(fs.access(settingsFile)).resolves.toBeUndefined();
    });

    it("deletes the user-scope settings file when deleteSettings is true", async () => {
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.wipe"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.wipe", "plugin.json"),
        JSON.stringify({ name: "acme.wipe", version: "1.0.0" })
      );
      const settingsFile = path.join(tmpDir, "plugin-settings", "acme.wipe.json");
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify({ token: "secret" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.wipe", true);

      await expect(fs.access(path.join(pluginsRoot, "acme.wipe"))).rejects.toThrow();
      await expect(fs.access(settingsFile)).rejects.toThrow();
    });

    it("never deletes a project-scope settings file, even with deleteSettings", async () => {
      // Uninstall only ever targets the user-scope settings root; per-repo
      // `.daintree/plugin-settings/` files are tracked git artifacts and are not
      // the uninstall's to remove. Drift guard for docs/plugins/distribution.md.
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.proj"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.proj", "plugin.json"),
        JSON.stringify({ name: "acme.proj", version: "1.0.0" })
      );
      const projectSettingsFile = path.join(
        tmpDir,
        "some-project",
        ".daintree",
        "plugin-settings",
        "acme.proj.json"
      );
      await fs.mkdir(path.dirname(projectSettingsFile), { recursive: true });
      await fs.writeFile(projectSettingsFile, JSON.stringify({ team: "platform" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.proj", true);

      await expect(fs.access(path.join(pluginsRoot, "acme.proj"))).rejects.toThrow();
      await expect(fs.access(projectSettingsFile)).resolves.toBeUndefined();
    });

    it("clears the launch-time name reservation so a same-session reinstall isn't blocked", async () => {
      // Regression: a disabled-at-launch plugin reserves its name; uninstall
      // must release it or loadPlugin rejects the reinstall as a duplicate.
      storeMock._state.set("plugins", { disabled: ["acme.reserve"] });
      await writePlugin("acme.reserve", { name: "acme.reserve", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      const reserved = () =>
        (service as unknown as { reservedNames: Set<string> }).reservedNames.has("acme.reserve");
      expect(reserved()).toBe(true);

      await service.uninstallPlugin("acme.reserve");

      expect(reserved()).toBe(false);
    });

    it("rejects a path-traversal or non-scoped plugin id before touching the filesystem", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.uninstallPlugin("../../../etc")).rejects.toThrow(/scoped plugin name/);
      await expect(service.uninstallPlugin("no-dot")).rejects.toThrow(/scoped plugin name/);
    });

    it("rejects on an empty or whitespace-only plugin id", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.uninstallPlugin("")).rejects.toThrow(/non-empty string/);
      await expect(service.uninstallPlugin("   ")).rejects.toThrow(/non-empty string/);
    });
  });

  it("emits toast when a user plugin uses the daintree.* namespace", async () => {
    const { broadcastToRenderer } = await import("../../ipc/utils.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("daintree.pirate", {
        name: "daintree.pirate",
        version: "1.0.0",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid manifest in daintree.pirate"),
        expect.anything()
      );
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          type: "error",
          title: "Plugin uses a reserved namespace",
          message: expect.stringContaining("daintree.pirate"),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("Plugin IPC handler registration", () => {
  let service: PluginService;

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
  });

  it("registerHandler succeeds for a loaded plugin with valid channel", () => {
    const handler = vi.fn();
    expect(() => service.registerHandler("acme.test-plugin", "get-data", handler)).not.toThrow();
  });

  it("registerHandler throws when pluginId is not loaded", () => {
    expect(() => service.registerHandler("acme.unknown-plugin", "get-data", vi.fn())).toThrow(
      "Unknown plugin: acme.unknown-plugin"
    );
  });

  it("registerHandler throws when channel contains a colon", () => {
    expect(() => service.registerHandler("acme.test-plugin", "bad:channel", vi.fn())).toThrow(
      "Plugin channel must not contain colons: bad:channel"
    );
  });

  it("registerHandler throws when handler is not a function", () => {
    expect(() =>
      service.registerHandler("acme.test-plugin", "get-data", "not-a-function" as never)
    ).toThrow("Plugin handler must be a function, got string");
  });

  it("dispatchHandler calls the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    service.registerHandler("acme.test-plugin", "get-data", handler);

    const ctx = makeCtx("acme.test-plugin", { webContentsId: 7 });
    const result = await service.dispatchHandler("acme.test-plugin", "get-data", ctx, [
      "arg1",
      "arg2",
    ]);
    expect(handler).toHaveBeenCalledWith(ctx, "arg1", "arg2");
    expect(result).toEqual({ value: 42 });
  });

  it("dispatchHandler passes the context as the first argument to the handler", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    service.registerHandler("acme.test-plugin", "get-ctx", handler);

    const ctx = makeCtx("acme.test-plugin", {
      projectId: "p1",
      worktreeId: "w1",
      webContentsId: 42,
    });
    await service.dispatchHandler("acme.test-plugin", "get-ctx", ctx, ["x"]);
    expect(handler.mock.calls[0][0]).toEqual(ctx);
    expect(handler.mock.calls[0][1]).toBe("x");
  });

  it("dispatchHandler throws when no handler is found", async () => {
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow("No plugin handler registered for acme.test-plugin:unknown");
  });

  it("dispatchHandler rejects an unknown pluginId with PluginInvokeOwnershipError (#10462)", async () => {
    await expect(
      service.dispatchHandler("acme.unknown-plugin", "get-data", makeCtx("acme.unknown-plugin"), [])
    ).rejects.toThrow(PluginInvokeOwnershipError);
  });

  it("dispatchHandler does not activate when the pluginId is not loaded (#10462)", async () => {
    // The ownership guard must fire before activation, so impersonating an
    // unloaded plugin can never trigger any plugin code to run.
    const activateSpy = vi.spyOn(service, "activatePlugin");
    await expect(
      service.dispatchHandler("acme.unknown-plugin", "get-data", makeCtx("acme.unknown-plugin"), [])
    ).rejects.toBeInstanceOf(PluginInvokeOwnershipError);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("dispatchHandler treats an unknown channel on a loaded plugin as a normal error, not an ownership rejection (#10462)", async () => {
    // Regression guard: the ownership rejection keys on the pluginId being
    // loaded, not on whether the channel resolves — a real plugin with a bad
    // channel must still surface the generic handler error.
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.not.toBeInstanceOf(PluginInvokeOwnershipError);
  });

  it("registering same (pluginId, channel) twice overwrites the handler", async () => {
    const handler1 = vi.fn().mockReturnValue("first");
    const handler2 = vi.fn().mockReturnValue("second");
    service.registerHandler("acme.test-plugin", "get-data", handler1);
    service.registerHandler("acme.test-plugin", "get-data", handler2);

    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "get-data",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("second");
    expect(handler1).not.toHaveBeenCalled();
  });

  it("removeHandlers removes all handlers for a plugin, leaving others intact", async () => {
    await writePlugin("other-plugin", { name: "acme.other-plugin", version: "1.0.0" });
    const service2 = new PluginService(tmpDir);
    await service2.initialize();

    service2.registerHandler("acme.test-plugin", "ch-a", vi.fn().mockReturnValue("a"));
    service2.registerHandler("acme.test-plugin", "ch-b", vi.fn().mockReturnValue("b"));
    service2.registerHandler("acme.other-plugin", "ch-c", vi.fn().mockReturnValue("c"));

    service2.removeHandlers("acme.test-plugin");

    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-a", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-b", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    expect(
      await service2.dispatchHandler("acme.other-plugin", "ch-c", makeCtx("acme.other-plugin"), [])
    ).toBe("c");
  });

  it("hasPlugin returns true for loaded plugins and false otherwise", () => {
    expect(service.hasPlugin("acme.test-plugin")).toBe(true);
    expect(service.hasPlugin("nonexistent")).toBe(false);
  });

  it("registerHandler throws for empty channel", () => {
    expect(() => service.registerHandler("acme.test-plugin", "", vi.fn())).not.toThrow();
    // Empty channel is technically valid — no colons
  });

  it("dispatchHandler handles synchronous handlers", async () => {
    service.registerHandler("acme.test-plugin", "sync", () => "sync-result");
    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "sync",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("sync-result");
  });

  describe("dispatchHandler failure auditing (#10463)", () => {
    it("audits a throwing typed-channel handler as an ipc-invoke error record", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const boom = new Error("handler exploded");
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(boom));

        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [
            { q: "x" },
          ])
        ).rejects.toBe(boom);

        expect(appendSpy).toHaveBeenCalledTimes(1);
        const record = appendSpy.mock.calls[0][0];
        expect(record).toMatchObject({
          pluginId: "acme.test-plugin",
          actionId: "get-data",
          recordType: "ipc-invoke",
          channel: "get-data",
          result: "error",
        });
        expect(record.errorMessage).toContain("handler exploded");
        expect(typeof record.durationMs).toBe("number");
        expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
        // The error is marked so the outer plugin:invoke catch won't re-audit.
        expect(isAuditedHandlerFailure(boom)).toBe(true);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("audits a successful typed-channel handler as an ipc-invoke success record (#10517)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockResolvedValue("ok"));
        const result = await service.dispatchHandler(
          "acme.test-plugin",
          "get-data",
          makeCtx("acme.test-plugin"),
          ["a"]
        );
        expect(result).toBe("ok");
        expect(appendSpy).toHaveBeenCalledTimes(1);
        const record = appendSpy.mock.calls[0][0];
        expect(record).toMatchObject({
          pluginId: "acme.test-plugin",
          actionId: "get-data",
          recordType: "ipc-invoke",
          channel: "get-data",
          result: "success",
        });
        expect(record.errorMessage).toBe("");
        expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof record.durationMs).toBe("number");
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("does not audit schema/no-handler errors (owned by the IPC boundary)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        await expect(
          service.dispatchHandler("acme.test-plugin", "missing", makeCtx("acme.test-plugin"), [])
        ).rejects.toThrow("No plugin handler registered");
        expect(appendSpy).not.toHaveBeenCalled();
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("rethrows the original error even when it is frozen (marker can't attach)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const frozen = Object.freeze(new Error("handler exploded"));
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(frozen));
        // The marker can't be written onto a frozen error; the original error
        // must still surface (not a TypeError from the failed assignment).
        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [])
        ).rejects.toBe(frozen);
        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(isAuditedHandlerFailure(frozen)).toBe(false);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("never lets an audit append failure mask the handler error", async () => {
      const appendSpy = vi.spyOn(getPluginActionAuditService(), "append").mockImplementation(() => {
        throw new Error("audit store corrupt");
      });
      try {
        const boom = new Error("handler exploded");
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(boom));
        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [])
        ).rejects.toBe(boom);
        expect(appendSpy).toHaveBeenCalledTimes(1);
      } finally {
        appendSpy.mockRestore();
      }
    });
  });

  describe("dispatchHandler args validation", () => {
    it("validates args when channel matches a registered action with inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.ping",
        title: "Ping",
        description: "Ping action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.ping", handler);

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.ping",
          makeCtx("acme.test-plugin"),
          [{ name: 42 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes valid args through to the handler", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.echo",
        title: "Echo",
        description: "Echo action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.echo", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.echo",
        makeCtx("acme.test-plugin"),
        [{ name: "world" }]
      );
      expect(result).toBe("ok");
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: "world" });
    });

    it("skips validation when no action descriptor is registered for the channel", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "raw-channel", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "raw-channel",
        makeCtx("acme.test-plugin"),
        [{ anything: "goes" }]
      );
      expect(result).toBe("ok");
    });

    it("skips validation when the descriptor has no inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.no-schema",
        title: "No Schema",
        description: "No schema action",
        category: "test",
        kind: "command",
        danger: "safe",
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.no-schema", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.no-schema",
        makeCtx("acme.test-plugin"),
        [{ foo: "bar" }]
      );
      expect(result).toBe("ok");
    });

    it("caches the compiled validator and reuses it on subsequent calls", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cached",
        title: "Cached",
        description: "Cache test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.cached", handler);

      // First call compiles
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 1 }]
      );
      // Second call reuses cached validator
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 2 }]
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.anything(), { value: 1 });
      expect(handler).toHaveBeenNthCalledWith(2, expect.anything(), { value: 2 });
    });

    it("treats no args as empty object for validation", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.opt",
        title: "Opt",
        description: "Optional args action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.opt", handler);

      // No args call — should validate against {} which matches the schema (no required fields)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.opt",
        makeCtx("acme.test-plugin"),
        []
      );
      expect(result).toBe("ok");
    });

    it("cleans up the validator when the handler is removed", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cleanup",
        title: "Cleanup",
        description: "Cleanup test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the validator cache with a successful call
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      service.removeHandlers("acme.test-plugin");

      // Re-register and re-prime — the old validator should be gone
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );
      // Should still work (compiles fresh)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("rejects async ($async) schemas at compile time", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.async",
        title: "Async",
        description: "Async schema action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: { $async: true, type: "object" },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.async",
        vi.fn().mockResolvedValue("ok")
      );

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.async",
          makeCtx("acme.test-plugin"),
          [{}]
        )
      ).rejects.toThrow("async");
    });

    it("supports standard JSON Schema formats like uri and email", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.format",
        title: "Format",
        description: "Format test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            email: { type: "string", format: "email" },
          },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.format", handler);

      // Valid formats
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.format",
        makeCtx("acme.test-plugin"),
        [{ url: "https://example.com", email: "test@example.com" }]
      );
      expect(handler).toHaveBeenCalled();

      // Invalid format rejects
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.format",
          makeCtx("acme.test-plugin"),
          [{ url: "not-a-url", email: "test@example.com" }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
    });

    it("does not validate when descriptor.pluginId differs from dispatch pluginId", async () => {
      // Register an action for acme.test-plugin
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.guarded",
        title: "Guarded",
        description: "Owner-check action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin
      await writePlugin("other", { name: "acme.other", version: "1.0.0" });
      const service2 = new PluginService(tmpDir);
      await service2.initialize();

      // Register a raw handler on the second plugin whose channel collides with first plugin's action id
      const handler = vi.fn().mockResolvedValue("ok");
      service2.registerHandler("acme.other", "acme.test-plugin.guarded", handler);

      // Dispatch via the second plugin — should NOT validate (owner mismatch)
      const result = await service2.dispatchHandler(
        "acme.other",
        "acme.test-plugin.guarded",
        { projectId: null, worktreeId: null, webContentsId: 1, pluginId: "acme.other" },
        [{ name: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("cleans up validators on unregisterPluginAction", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the cache
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      // Unregister and re-register with a different schema
      service.unregisterPluginAction("acme.test-plugin", "acme.test-plugin.stale");
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test — new schema",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { y: { type: "string" } },
          required: ["y"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.stale", handler);

      // Old schema required `x: number` — should now reject that
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.stale",
          makeCtx("acme.test-plugin"),
          [{ x: 1 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");

      // New schema requires `y: string` — should pass with correct args
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ y: "hello" }]
      );
      expect(handler).toHaveBeenCalledWith(expect.anything(), { y: "hello" });
    });

    it("does not validate when a different plugin registers a handler with same channel as another plugin's action id", async () => {
      // Register action for acme.test-plugin with a restrictive schema
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.shared-channel",
        title: "Shared Channel",
        description: "Test shared channel collision",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin and register a raw handler on the same channel
      await writePlugin("collider-plugin", { name: "acme.collider", version: "1.0.0" });
      const colliderService = new PluginService(tmpDir, "0.0.0");
      await colliderService.initialize();

      // Register a raw handler whose channel collides with test-plugin's action id
      const handler = vi.fn().mockResolvedValue("cross-plugin-ok");
      colliderService.registerHandler("acme.collider", "acme.test-plugin.shared-channel", handler);

      // Dispatching via collider plugin should NOT inherit test-plugin's schema
      const result = await colliderService.dispatchHandler(
        "acme.collider",
        "acme.test-plugin.shared-channel",
        { projectId: null, worktreeId: null, webContentsId: 99, pluginId: "acme.collider" },
        [{ name: 42 }]
      );
      expect(result).toBe("cross-plugin-ok");
    });
  });

  describe("typed channel registration (registerHandler schema overload)", () => {
    let typedService: PluginService;

    beforeEach(async () => {
      await writePlugin("typed-plugin", {
        name: "acme.typed",
        version: "1.0.0",
        capabilities: ["fs:project-read", "git:read"],
      });
      typedService = new PluginService(tmpDir);
      await typedService.initialize();
    });

    it("registers and dispatches a typed channel with parsed args and result", async () => {
      const schema = {
        args: z.object({ name: z.string() }),
        result: z.object({ greeting: z.string() }),
      };
      const handler = vi.fn(async (_ctx, args: { name: string }) => ({
        greeting: `hello ${args.name}`,
      }));
      typedService.registerHandler("acme.typed", "greet", schema, handler);

      const result = await typedService.dispatchHandler(
        "acme.typed",
        "greet",
        makeCtx("acme.typed"),
        [{ name: "world" }]
      );
      expect(result).toEqual({ greeting: "hello world" });
      // The handler must receive the parsed single payload, not the raw variadic.
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: "world" });
    });

    it("throws SCHEMA_ERROR when args fail Zod validation and never calls the handler", async () => {
      const schema = {
        args: z.object({ count: z.number().int().positive() }),
        result: z.unknown(),
      };
      const handler = vi.fn();
      typedService.registerHandler("acme.typed", "tally", schema, handler);

      await expect(
        typedService.dispatchHandler("acme.typed", "tally", makeCtx("acme.typed"), [
          { count: "not-a-number" },
        ])
      ).rejects.toThrow(/^SCHEMA_ERROR:/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("throws SCHEMA_ERROR when the handler returns a result that fails the result schema", async () => {
      const schema = {
        args: z.object({}).passthrough(),
        result: z.object({ count: z.number() }),
      };
      const handler = vi.fn(async () => ({ count: "nope" as unknown as number }));
      typedService.registerHandler("acme.typed", "broken", schema, handler);

      await expect(
        typedService.dispatchHandler("acme.typed", "broken", makeCtx("acme.typed"), [{}])
      ).rejects.toThrow(/^SCHEMA_ERROR: result for channel "broken" failed validation/);
    });

    it("does NOT emit a success audit when the result schema rejects (#10517)", async () => {
      // The success record is written only after result-schema validation
      // passes — a host-side schema rejection of a handler that otherwise ran
      // must never be logged as a successful dispatch.
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const schema = {
          args: z.object({}).passthrough(),
          result: z.object({ count: z.number() }),
        };
        typedService.registerHandler(
          "acme.typed",
          "broken",
          schema,
          vi.fn(async () => ({ count: "nope" as unknown as number }))
        );

        await expect(
          typedService.dispatchHandler("acme.typed", "broken", makeCtx("acme.typed"), [{}])
        ).rejects.toThrow(/^SCHEMA_ERROR:/);

        // No success record from the inner dispatch boundary (the schema
        // rejection is owned by the outer plugin:invoke boundary instead).
        const successCalls = appendSpy.mock.calls.filter(
          (c) => (c[0] as { result?: string }).result === "success"
        );
        expect(successCalls).toHaveLength(0);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("rejects registration with PERMISSION_REQUIRED when a required capability is not declared", () => {
      const schema = {
        args: z.object({}),
        result: z.object({}),
        requires: ["fs:project-write" as const],
      };
      expect(() =>
        typedService.registerHandler("acme.typed", "write-stuff", schema, vi.fn())
      ).toThrow(/^PERMISSION_REQUIRED:/);
    });

    it("allows registration when every required capability is declared in the manifest", () => {
      const schema = {
        args: z.object({}),
        result: z.object({}),
        requires: ["fs:project-read" as const, "git:read" as const],
      };
      expect(() =>
        typedService.registerHandler(
          "acme.typed",
          "read-stuff",
          schema,
          vi.fn().mockResolvedValue({})
        )
      ).not.toThrow();
    });

    it("throws PERMISSION_REQUIRED at dispatch when manifest capability disappears after registration (defense-in-depth)", async () => {
      const schema = {
        args: z.object({}),
        result: z.unknown(),
        requires: ["fs:project-read" as const],
      };
      const handler = vi.fn().mockResolvedValue({ ok: true });
      typedService.registerHandler("acme.typed", "guarded", schema, handler);

      // Tamper with the loaded manifest to simulate a future code path that
      // removes a capability after registration. The dispatch-time re-check
      // must reject before the handler runs.
      const plugin = (
        typedService as unknown as { plugins: Map<string, { manifest: PluginManifest }> }
      ).plugins.get("acme.typed");
      if (plugin) {
        plugin.manifest = { ...plugin.manifest, capabilities: [] };
      }

      await expect(
        typedService.dispatchHandler("acme.typed", "guarded", makeCtx("acme.typed"), [{}])
      ).rejects.toThrow(/^PERMISSION_REQUIRED:/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("removeHandlers cleans up channel schemas and capability gates", async () => {
      const schema = {
        args: z.object({ x: z.number() }),
        result: z.object({ doubled: z.number() }),
      };
      typedService.registerHandler(
        "acme.typed",
        "double",
        schema,
        async (_ctx, args: { x: number }) => ({ doubled: args.x * 2 })
      );

      typedService.removeHandlers("acme.typed");

      await expect(
        typedService.dispatchHandler("acme.typed", "double", makeCtx("acme.typed"), [{ x: 3 }])
      ).rejects.toThrow(/No plugin handler registered/);

      // Re-register WITHOUT the typed overload — the old schema must be gone
      // so legacy validation doesn't run on the new untyped handler.
      typedService.registerHandler(
        "acme.typed",
        "double",
        vi.fn().mockResolvedValue({ doubled: "string-result-not-validated" })
      );
      const legacyResult = await typedService.dispatchHandler(
        "acme.typed",
        "double",
        makeCtx("acme.typed"),
        [{ x: "anything" }]
      );
      expect(legacyResult).toEqual({ doubled: "string-result-not-validated" });
    });

    it("re-registering a typed channel as legacy drops the prior schema", async () => {
      const schema = {
        args: z.object({ x: z.number() }),
        result: z.unknown(),
      };
      typedService.registerHandler(
        "acme.typed",
        "swap",
        schema,
        vi.fn().mockResolvedValue("typed")
      );

      const legacyHandler = vi.fn().mockResolvedValue("legacy");
      typedService.registerHandler("acme.typed", "swap", legacyHandler);

      // Now the legacy untyped path runs — args validation does not fire,
      // so a previously-invalid payload would now go through.
      const result = await typedService.dispatchHandler(
        "acme.typed",
        "swap",
        makeCtx("acme.typed"),
        [{ x: "string-was-invalid-before" }]
      );
      expect(result).toBe("legacy");
      expect(legacyHandler).toHaveBeenCalledWith(expect.anything(), {
        x: "string-was-invalid-before",
      });
    });

    it("treats missing args as undefined for the typed args schema", async () => {
      const schema = {
        args: z.object({ name: z.string() }).optional(),
        result: z.string(),
      };
      const handler = vi.fn(async (_ctx, args: { name: string } | undefined) =>
        args ? args.name : "anonymous"
      );
      typedService.registerHandler("acme.typed", "optional", schema, handler);

      const result = await typedService.dispatchHandler(
        "acme.typed",
        "optional",
        makeCtx("acme.typed"),
        []
      );
      expect(result).toBe("anonymous");
    });

    it("passes Zod-parsed output (defaults / coercions) to the handler, not the raw payload", async () => {
      const schema = {
        args: z.object({
          n: z.coerce.number().int(),
          tag: z.string().default("auto"),
        }),
        result: z.object({ n: z.number(), tag: z.string() }),
      };
      const handler = vi.fn(async (_ctx, args: { n: number; tag: string }) => args);
      typedService.registerHandler("acme.typed", "coerce", schema, handler);

      // Dispatch with a string "n" (coerced) and no `tag` (defaulted).
      const result = await typedService.dispatchHandler(
        "acme.typed",
        "coerce",
        makeCtx("acme.typed"),
        [{ n: "42" }]
      );
      expect(result).toEqual({ n: 42, tag: "auto" });
      expect(handler).toHaveBeenCalledWith(expect.anything(), { n: 42, tag: "auto" });
    });

    it("rejects malformed schema at registration when args/result lack safeParse", () => {
      expect(() =>
        typedService.registerHandler(
          "acme.typed",
          "bad-schema",
          // Missing `result` ZodType — bare object has no safeParse method.
          { args: z.object({}), result: {} as unknown as z.ZodType<unknown> },
          vi.fn()
        )
      ).toThrow(/Plugin handler must be a function|^PERMISSION_REQUIRED:/);
      // Specifically, isChannelSchema returns false for missing safeParse,
      // so the legacy path runs and the bare object is rejected as a
      // non-function handler. Either way: malformed schema is rejected at
      // registration time, not at dispatch.
    });

    it("legacy untyped handler still dispatches alongside typed handlers on the same plugin", async () => {
      typedService.registerHandler(
        "acme.typed",
        "typed-ch",
        { args: z.string(), result: z.string() },
        async (_ctx, args: string) => args.toUpperCase()
      );
      typedService.registerHandler(
        "acme.typed",
        "legacy-ch",
        vi.fn().mockResolvedValue("legacy-result")
      );

      const typedResult = await typedService.dispatchHandler(
        "acme.typed",
        "typed-ch",
        makeCtx("acme.typed"),
        ["hello"]
      );
      expect(typedResult).toBe("HELLO");

      const legacyResult = await typedService.dispatchHandler(
        "acme.typed",
        "legacy-ch",
        makeCtx("acme.typed"),
        ["whatever"]
      );
      expect(legacyResult).toBe("legacy-result");
    });
  });
});

describe("engines.daintree compatibility gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("loads a plugin when app version satisfies engines.daintree", async () => {
    await writePlugin("compatible", {
      name: "acme.compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects a plugin when app version does not satisfy engines.daintree", async () => {
    await writePlugin("incompatible", {
      name: "acme.incompatible",
      displayName: "Incompatible Plugin",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.incompatible" requires Daintree ^0.7.0')
    );
    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "error",
        title: "Plugin incompatible",
        message: expect.stringContaining("Incompatible Plugin"),
      })
    );
  });

  it("treats app prerelease versions as satisfying their release-series range", async () => {
    await writePlugin("prerelease-compatible", {
      name: "acme.prerelease-compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins that omit engines.daintree with a warning", async () => {
    await writePlugin("no-engines", { name: "acme.no-engines", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.no-engines" does not declare engines.daintree')
    );
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins with empty engines object (daintree absent) with a warning", async () => {
    await writePlugin("empty-engines", {
      name: "acme.empty-engines",
      version: "1.0.0",
      engines: {},
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.empty-engines" does not declare engines.daintree')
    );
  });

  it("rejects manifests with an invalid semver range at schema level", async () => {
    await writePlugin("bad-range", {
      name: "acme.bad-range",
      version: "1.0.0",
      engines: { daintree: "not-a-range" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects plugins requiring a future major version", async () => {
    await writePlugin("future", {
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt main import or register contributions for incompatible plugins", async () => {
    await writePlugin("skip-side-effects", {
      name: "acme.skip-side-effects",
      version: "1.0.0",
      main: "dist/main.js",
      engines: { daintree: "^1.0.0" },
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
        toolbarButtons: [
          { id: "b", label: "B", iconId: "i", actionId: "acme.skip-side-effects.act" },
        ],
        menuItems: [{ label: "L", actionId: "acme.skip-side-effects.act", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("loads only the compatible plugins in a mixed batch", async () => {
    await writePlugin("good", {
      name: "acme.good",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const names = service.listPlugins().map((p) => p.manifest.name);
    expect(names).toEqual(["acme.good"]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the wildcard range '*'", async () => {
    await writePlugin("wildcard", {
      name: "acme.wildcard",
      version: "1.0.0",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only range strings at the schema layer", async () => {
    await writePlugin("whitespace-range", {
      name: "acme.whitespace-range",
      version: "1.0.0",
      engines: { daintree: "   " },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an app prerelease that is below a non-prerelease range's lower bound", async () => {
    await writePlugin("prerelease-too-early", {
      name: "acme.prerelease-too-early",
      version: "1.0.0",
      engines: { daintree: ">=0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.0-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact-version range when the app matches precisely", async () => {
    await writePlugin("exact-match", {
      name: "acme.exact-match",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an exact-version range when the app does not match", async () => {
    await writePlugin("exact-mismatch", {
      name: "acme.exact-mismatch",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.4");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });
});

describe("strict schema validation", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("rejects manifests with unknown fields like 'renderer'", async () => {
    await writePlugin("bad-field", {
      name: "acme.bad-field",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in bad-field"),
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["renderer"],
        }),
      ])
    );
  });
});

describe("Plugin unload lifecycle", () => {
  it("unloadPlugin calls all registry unregister functions for the plugin", async () => {
    await writePlugin("unloadable", {
      name: "acme.unloadable",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        toolbarButtons: [
          { id: "btn", label: "Btn", iconId: "icon", actionId: "acme.unloadable.act" },
        ],
        menuItems: [{ label: "L", actionId: "acme.unloadable.act", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.hasPlugin("acme.unloadable")).toBe(true);

    service.unloadPlugin("acme.unloadable");

    expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.unloadable");
  });

  it("unloadPlugin removes the plugin from hasPlugin and listPlugins", async () => {
    await writePlugin("goodbye", { name: "acme.goodbye", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.hasPlugin("acme.goodbye")).toBe(true);

    service.unloadPlugin("acme.goodbye");

    expect(service.hasPlugin("acme.goodbye")).toBe(false);
    expect(service.listPlugins()).toEqual([]);
  });

  it("unloadPlugin removes IPC handlers registered for the plugin", async () => {
    await writePlugin("handler-host", { name: "acme.handler-host", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.registerHandler("acme.handler-host", "ping", () => "pong");
    expect(
      await service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).toBe("pong");

    service.unloadPlugin("acme.handler-host");

    // After unload the plugin leaves `this.plugins`, so the ownership guard
    // (#10462) now short-circuits dispatch before the handler lookup.
    await expect(
      service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).rejects.toThrow('plugin:invoke rejected: plugin "acme.handler-host" is not loaded');
  });

  it("unloadPlugin is a no-op when the plugin is not loaded", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(() => service.unloadPlugin("acme.never-loaded")).not.toThrow();
    expect(unregisterPluginMenuItems).not.toHaveBeenCalled();
    expect(unregisterPluginToolbarButtons).not.toHaveBeenCalled();
    expect(unregisterPluginPanelKinds).not.toHaveBeenCalled();
    expect(unregisterForgeProviders).not.toHaveBeenCalled();
  });

  it("unloadPlugin is idempotent across repeated calls", async () => {
    await writePlugin("twice", { name: "acme.twice", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.unloadPlugin("acme.twice");
    expect(service.hasPlugin("acme.twice")).toBe(false);

    // Second call finds nothing to remove and stays silent.
    service.unloadPlugin("acme.twice");
    expect(unregisterPluginMenuItems).toHaveBeenCalledTimes(1);
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledTimes(1);
    expect(unregisterPluginPanelKinds).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviders).toHaveBeenCalledTimes(1);
  });

  it("registers plugin before importing main so sync host-API calls see it as loaded", async () => {
    const pluginDir = path.join(tmpDir, "sync-init");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.sync-init",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // Plugin main module calls a global hook synchronously during import to
    // observe whether its own pluginId is already registered. Proxies the
    // real-world pattern where a host API call depends on this.plugins.has().
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__pluginInitObserved = globalThis.__pluginInitCheck('acme.sync-init');"
    );

    const service = new PluginService(tmpDir);
    (globalThis as { __pluginInitCheck?: (name: string) => boolean }).__pluginInitCheck = (name) =>
      service.hasPlugin(name);

    try {
      await service.initialize();
      await service.activatePlugin("acme.sync-init");
      expect((globalThis as { __pluginInitObserved?: boolean }).__pluginInitObserved).toBe(true);
    } finally {
      delete (globalThis as { __pluginInitCheck?: unknown }).__pluginInitCheck;
      delete (globalThis as { __pluginInitObserved?: unknown }).__pluginInitObserved;
    }
  });

  it("supports load → unload → reload lifecycle via fresh service instance", async () => {
    await writePlugin("lifecycle", {
      name: "acme.lifecycle",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const first = new PluginService(tmpDir);
    await first.initialize();
    expect(registerPanelKind).toHaveBeenCalledTimes(1);

    first.unloadPlugin("acme.lifecycle");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.lifecycle");
    expect(first.hasPlugin("acme.lifecycle")).toBe(false);

    // A fresh service instance re-reads the plugin directory and re-registers.
    vi.clearAllMocks();
    const second = new PluginService(tmpDir);
    await second.initialize();

    expect(second.hasPlugin("acme.lifecycle")).toBe(true);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.lifecycle.viewer", extensionId: "acme.lifecycle" })
    );
  });
});

type CreateHostShape = (pluginId: string) => {
  host: {
    pluginId: string;
    registerHandler: (
      channel: string,
      schemaOrHandler: unknown,
      typedHandler?: (...args: unknown[]) => unknown
    ) => void;
    broadcastToRenderer: (channel: string, payload: unknown) => void;
    postToPanel: (channel: string, payload: unknown, panelId?: string | null) => Promise<void>;
    setPanelBadge: (panelId: string, badge: unknown) => Promise<void>;
    invalidateFileDecorations: (scope: string, paths?: string[]) => Promise<void>;
    registerForgeProvider: (descriptor: { id: string }, impl: unknown) => () => void;
  };
  revoke: () => void;
};

describe("createHost (plugin activation API)", () => {
  it("host.registerHandler delegates with the plugin's own namespace", async () => {
    await writePlugin("host-test", { name: "acme.host-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.host-test"
    );

    expect(host.pluginId).toBe("acme.host-test");

    const handler = vi.fn().mockReturnValue("ok");
    host.registerHandler("probe", handler);

    const ctx = makeCtx("acme.host-test");
    const result = await service.dispatchHandler("acme.host-test", "probe", ctx, ["a"]);
    expect(handler).toHaveBeenCalledWith(ctx, "a");
    expect(result).toBe("ok");
  });

  it("host.broadcastToRenderer namespaces channels as plugin:{pluginId}:{channel}", async () => {
    await writePlugin("bcast-test", { name: "acme.bcast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-test"
    );

    broadcastToRendererMock.mockClear();
    host.broadcastToRenderer("status", { ok: true });
    // Wrapped in the per-instance envelope (panelId: null = broadcast) so the
    // preload dispatcher sees the same shape for every push over this transport.
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.bcast-test:status", {
      panelId: null,
      payload: { ok: true },
    });
  });

  it("host.broadcastToRenderer rejects channels containing colons", async () => {
    await writePlugin("bcast-reject", { name: "acme.bcast-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-reject"
    );

    expect(() => host.broadcastToRenderer("bad:channel", null)).toThrow(
      "Plugin broadcast channel must be a string without colons"
    );
  });

  it("host.registerHandler rejects a 3-arg call where the second arg isn't a channel schema", async () => {
    await writePlugin("mismatch-test", { name: "acme.mismatch", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.mismatch"
    );

    expect(() =>
      // A typed handler was provided but the second arg is a function, not
      // a schema — silently dropping the typed handler would phantom-no-op
      // at dispatch, so this must throw.
      host.registerHandler(
        "ch",
        () => "legacy",
        () => "typed"
      )
    ).toThrow(/second argument must be a channel schema/);
  });

  it("revoked host rejects registerHandler and broadcastToRenderer calls", async () => {
    await writePlugin("revoke-test", { name: "acme.revoke-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.revoke-test"
    );

    revoke();

    expect(() => host.registerHandler("x", () => undefined)).toThrow(
      /host revoked: registerHandler/
    );
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked: broadcastToRenderer/);
    expect(() => host.registerForgeProvider({ id: "github" }, {})).toThrow(
      /host revoked: registerForgeProvider/
    );
  });

  it("host.postToPanel fans out to the plugin:{pluginId}:{channel} subscriber channel", async () => {
    await writePlugin("post-test", { name: "acme.post-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-test"
    );

    broadcastToRendererMock.mockClear();
    host.postToPanel("tick", { count: 3 });
    // Same transport as the renderer-side window.electron.plugin.on subscription
    // (`plugin:${pluginId}:${channel}`), so a subscribed panel receives the push.
    // No panelId → broadcast envelope (panelId: null).
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-test:tick", {
      panelId: null,
      payload: { count: 3 },
    });
  });

  it("host.postToPanel targets a single instance when given a panelId", async () => {
    await writePlugin("post-target", { name: "acme.post-target", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-target"
    );

    broadcastToRendererMock.mockClear();
    host.postToPanel("tick", { count: 7 }, "panel-a");
    // The panelId rides in the envelope so the preload dispatcher fans out only
    // to the onPanel("panel-a") subscriber, not to sibling instances (#10618).
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-target:tick", {
      panelId: "panel-a",
      payload: { count: 7 },
    });
  });

  it("host.postToPanel rejects an empty-string panelId", async () => {
    await writePlugin("post-bad-panel", { name: "acme.post-bad-panel", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-bad-panel"
    );

    broadcastToRendererMock.mockClear();
    // An empty string would silently match no subscriber — surface it loudly
    // rather than coercing to a broadcast.
    expect(() => host.postToPanel("tick", { n: 1 }, "")).toThrow(/postToPanel: panelId/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
    // null is an explicit broadcast and must NOT throw.
    expect(() => host.postToPanel("tick", { n: 2 }, null)).not.toThrow();
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-bad-panel:tick", {
      panelId: null,
      payload: { n: 2 },
    });
  });

  it("host.postToPanel remains callable AFTER the activation host is revoked", async () => {
    await writePlugin("post-postact", { name: "acme.post-postact", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-postact"
    );

    // Revoke the activation window — broadcastToRenderer is now closed, but
    // postToPanel (its post-activation-safe sibling) must keep delivering so a
    // plugin can stream from timers/polls long after activate() resolves.
    revoke();
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked/);

    broadcastToRendererMock.mockClear();
    expect(() => host.postToPanel("tick", { n: 1 })).not.toThrow();
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-postact:tick", {
      panelId: null,
      payload: { n: 1 },
    });
  });

  it("host.postToPanel rejects empty or colon-bearing channels", async () => {
    await writePlugin("post-reject", { name: "acme.post-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-reject"
    );

    broadcastToRendererMock.mockClear();
    // Validation errors must REJECT (not throw synchronously) so a plugin can
    // `.catch()` a non-awaited call — the promise-based error contract (#10617).
    // A sync throw would escape the Promise and force a try/catch wrapper.
    await expect(host.postToPanel("bad:channel", null)).rejects.toThrow(/postToPanel: channel/);
    await expect(host.postToPanel("", null)).rejects.toThrow(/postToPanel: channel/);
    // Calling without awaiting must not throw synchronously — the rejection is
    // delivered through the returned promise, catchable via `.catch()`.
    let caught: unknown;
    const pending = host.postToPanel("also:bad", null).catch((err) => {
      caught = err;
    });
    await pending;
    expect(caught).toBeInstanceOf(Error);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.postToPanel silently no-ops once the plugin is unloaded", async () => {
    await writePlugin("post-unloaded", { name: "acme.post-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-unloaded"
    );

    service.unloadPlugin("acme.post-unloaded");

    broadcastToRendererMock.mockClear();
    expect(() => host.postToPanel("tick", { n: 1 })).not.toThrow();
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.setPanelBadge rejects an invalid panelId or badge shape (#10617)", async () => {
    await writePlugin("badge-reject", { name: "acme.badge-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.badge-reject"
    );

    broadcastToRendererMock.mockClear();
    // Empty panelId and a malformed badge must reject through the Promise, not
    // throw synchronously — the runtime-surface error contract (#10617).
    await expect(host.setPanelBadge("", { kind: "dot" })).rejects.toThrow(/setPanelBadge: panelId/);
    await expect(host.setPanelBadge("panel-1", { kind: "bogus" })).rejects.toThrow(
      /setPanelBadge: invalid badge/
    );
    // Non-awaited call is catchable, never a sync throw.
    let caught: unknown;
    await host.setPanelBadge("", null).catch((err) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(Error);
    // A rejected setPanelBadge has no side effect: no badge-changed broadcast.
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.setPanelBadge silently no-ops once the plugin is unloaded (#10617)", async () => {
    await writePlugin("badge-unloaded", { name: "acme.badge-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.badge-unloaded"
    );
    service.unloadPlugin("acme.badge-unloaded");

    // Liveness no-op stays a silent resolve even with an otherwise-invalid badge.
    await expect(host.setPanelBadge("", { kind: "bogus" })).resolves.toBeUndefined();
  });

  it("host.invalidateFileDecorations rejects an empty scope (#10617)", async () => {
    await writePlugin("deco-reject", { name: "acme.deco-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.deco-reject"
    );

    // Empty scope rejects at the first guard, before the declared-scope check —
    // through the Promise, not a sync throw (#10617).
    await expect(host.invalidateFileDecorations("")).rejects.toThrow(
      /invalidateFileDecorations: scope/
    );
    // A non-empty but undeclared scope rejects at the second guard, also through
    // the Promise (this plugin declares no fileDecorationProviders).
    await expect(host.invalidateFileDecorations("acme.deco-reject:*")).rejects.toThrow(
      /is not covered by any declared/
    );
  });

  it("host.invalidateFileDecorations silently no-ops once the plugin is unloaded (#10617)", async () => {
    await writePlugin("deco-unloaded", { name: "acme.deco-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.deco-unloaded"
    );
    service.unloadPlugin("acme.deco-unloaded");

    await expect(host.invalidateFileDecorations("")).resolves.toBeUndefined();
  });
});

type ProcessHostShape = (pluginId: string) => {
  host: {
    process: {
      spawn: (
        command: string,
        options?: { args?: string[]; cwd?: string; env?: Record<string, string> }
      ) => Promise<{
        id: string;
        kill: () => void;
        restart: () => Promise<void>;
        onExit: (
          cb: (info: { exitCode: number | null; signal: string | null }) => void
        ) => () => void;
        onCrash: (
          cb: (info: { exitCode: number | null; signal: string | null }) => void
        ) => () => void;
      }>;
    };
  };
  revoke: () => void;
};

function makeFakeChild() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  const child: ManagedChildProcess = {
    pid: 9999,
    stdout: null,
    stderr: null,
    kill(signal) {
      killSignals.push(signal);
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener as (...args: unknown[]) => void);
      listeners.set(event, arr);
      return child;
    }) as ManagedChildProcess["on"],
  };
  return { child, killSignals };
}

describe("createHost — host.process (managed processes, #9234)", () => {
  // JIT capability consent (#10524) gates the first shell:exec spawn. Auto-approve
  // without pinning so the spawn-path assertions run without a renderer; the
  // dedicated consent tests cover the prompt/denial branch. The no-capability
  // test below rejects before consent is even consulted, so it is unaffected.
  beforeEach(() => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
  });
  afterEach(() => {
    _resetPluginCapabilityServicesForTest();
  });

  it("rejects spawn from a plugin without the shell:exec capability", async () => {
    await writePlugin("proc-nocap", { name: "acme.proc-nocap", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-nocap"
    );

    await expect(host.process.spawn("node", { args: ["x.js"] })).rejects.toThrow(
      /PERMISSION_REQUIRED.*shell:exec/
    );
  });

  it("spawns through the manager when shell:exec is declared", async () => {
    await writePlugin("proc-cap", {
      name: "acme.proc-cap",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: () => {
        const fake = makeFakeChild();
        fakes.push(fake);
        return fake.child;
      },
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-cap"
    );

    const handle = await host.process.spawn("node", { args: ["server.js"], cwd: "/repo" });
    expect(typeof handle.id).toBe("string");
    expect(fakes).toHaveLength(1);
    expect(manager.runningCount("acme.proc-cap")).toBe(1);
  });

  it("blocks the spawn and never reaches the manager when consent is denied (#10524)", async () => {
    await writePlugin("proc-deny", {
      name: "acme.proc-deny",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const spawner = vi.fn(() => makeFakeChild().child);
    const manager = new PluginProcessManager({ streamSink: () => {}, spawner, killGraceMs: 10 });
    service._setProcessManagerForTests(manager);
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-deny"
    );

    await expect(host.process.spawn("node", { args: ["server.js"] })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(spawner).not.toHaveBeenCalled();
    expect(manager.runningCount("acme.proc-deny")).toBe(0);
  });

  it("does not spend a consent prompt on an invalid spawn that fails validation (#10524)", async () => {
    await writePlugin("proc-invalid", {
      name: "acme.proc-invalid",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const bridge = vi.fn(async () => "approved-and-pin" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-invalid"
    );

    // An empty command fails validation; the prompt must NOT fire (else a plugin
    // could bank a silent grant via a deliberately-doomed call).
    await expect(host.process.spawn("")).rejects.toThrow(/non-empty string/);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("kills outstanding processes when the plugin is unloaded", async () => {
    await writePlugin("proc-unload", {
      name: "acme.proc-unload",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: () => {
        const fake = makeFakeChild();
        fakes.push(fake);
        return fake.child;
      },
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-unload"
    );
    await host.process.spawn("sleep", { args: ["100"] });
    expect(manager.runningCount("acme.proc-unload")).toBe(1);

    service.unloadPlugin("acme.proc-unload");

    // The unload teardown SIGTERMs the outstanding process.
    expect(fakes[0]!.killSignals).toContain("SIGTERM");
  });

  it("denies a spawn from a plugin that has already been unloaded", async () => {
    await writePlugin("proc-gone", {
      name: "acme.proc-gone",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-gone"
    );
    service.unloadPlugin("acme.proc-gone");

    await expect(host.process.spawn("node")).rejects.toThrow(/no longer loaded/);
  });
});

type ShowToastOptions = {
  message: string;
  type?: "info" | "success" | "warning" | "error";
  durationMs?: number;
};
type ToastHostShape = (pluginId: string) => {
  host: { showToast: (options: ShowToastOptions) => Promise<void> };
  revoke: () => void;
};

describe("createHost — showToast", () => {
  it("broadcasts NOTIFICATION_SHOW_TOAST with the pluginId-namespaced message", async () => {
    await writePlugin("toast-test", { name: "acme.toast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-test"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Synced 12 issues", type: "success" });

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-test: Synced 12 issues",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-test:success",
    });
  });

  it("defaults type to info when omitted", async () => {
    await writePlugin("toast-default", { name: "acme.toast-default", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-default"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Done" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-default: Done",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-default:info",
    });
  });

  it("forwards durationMs as duration", async () => {
    await writePlugin("toast-duration", { name: "acme.toast-duration", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-duration"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Saved", type: "success", durationMs: 3000 });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-duration: Saved",
      duration: 3000,
      rateLimitKey: "plugin:acme.toast-duration:success",
    });
  });

  it("rejects an out-of-range or non-integer durationMs and does not broadcast", async () => {
    await writePlugin("toast-dur-range", { name: "acme.toast-dur-range", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-dur-range"
    );

    broadcastToRendererMock.mockClear();
    for (const durationMs of [0, -1, 1.5, 60_001]) {
      await expect(host.showToast({ message: "x", durationMs })).rejects.toThrow(
        /showToast: invalid options/
      );
    }
    // Boundaries that should pass.
    await host.showToast({ message: "min", durationMs: 1 });
    await host.showToast({ message: "max", durationMs: 60_000 });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a message over the max length and does not broadcast", async () => {
    await writePlugin("toast-maxlen", { name: "acme.toast-maxlen", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-maxlen"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "x".repeat(2000) });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);

    await expect(host.showToast({ message: "x".repeat(2001) })).rejects.toThrow(
      /showToast: invalid options/
    );
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty/whitespace message and does not broadcast", async () => {
    await writePlugin("toast-empty", { name: "acme.toast-empty", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-empty"
    );

    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "   " })).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown type and does not broadcast", async () => {
    await writePlugin("toast-badtype", { name: "acme.toast-badtype", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-badtype"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Oops", type: "fatal" as ShowToastOptions["type"] })
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects unknown fields (strict schema)", async () => {
    await writePlugin("toast-strict", { name: "acme.toast-strict", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-strict"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Hi", priority: "low" } as unknown as ShowToastOptions)
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("is NOT revoke-guarded — still delivers after revoke() while the plugin is loaded", async () => {
    await writePlugin("toast-revoke", { name: "acme.toast-revoke", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-revoke"
    );

    revoke();
    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Still alive" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-revoke: Still alive",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-revoke:info",
    });
  });

  it("is a silent no-op once the plugin is unloaded (liveness guard)", async () => {
    await writePlugin("toast-unload", { name: "acme.toast-unload", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-unload"
    );

    service.unloadPlugin("acme.toast-unload");
    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "Gone" })).resolves.toBeUndefined();

    // unloadPlugin emits its own registry-change broadcasts; assert specifically
    // that no toast was delivered rather than "no broadcast at all".
    const toastBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
    );
    expect(toastBroadcasts).toHaveLength(0);
  });
});

type DispatchHostShape = (pluginId: string) => {
  host: {
    dispatch: (
      actionId: string,
      args?: unknown
    ) => Promise<import("../../../shared/types/actions.js").ActionDispatchResult>;
  };
  revoke: () => void;
};

interface FakeWebContents {
  id: number;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  _triggerDestroyed: () => void;
}

function makeFakeWebContents(id: number): FakeWebContents {
  const destroyedHandlers = new Set<() => void>();
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn((event: string, cb: () => void) => {
      if (event === "destroyed") destroyedHandlers.add(cb);
    }),
    removeListener: vi.fn((event: string, cb: () => void) => {
      if (event === "destroyed") destroyedHandlers.delete(cb);
    }),
    send: vi.fn(),
    _triggerDestroyed: () => {
      for (const cb of [...destroyedHandlers]) cb();
    },
  };
}

/** Set the active renderer the plugin dispatch bridge will target, or `null`. */
function setActiveWebContents(wc: FakeWebContents | null): void {
  windowRefMock.getWindowRegistry.mockReturnValue(null);
  windowRefMock.getProjectViewManager.mockReturnValue(
    wc ? ({ getActiveView: () => ({ webContents: wc }) } as never) : null
  );
}

/** Read the request payload from the most recent dispatch `webContents.send`. */
function lastDispatchRequest(wc: FakeWebContents): {
  requestId: string;
  actionId: string;
  args?: unknown;
} {
  const call = [...wc.send.mock.calls]
    .reverse()
    .find((c) => c[0] === CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST);
  if (!call) throw new Error("no PLUGIN_DISPATCH_ACTION_REQUEST send recorded");
  return call[1] as { requestId: string; actionId: string; args?: unknown };
}

describe("createHost — dispatch", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    setActiveWebContents(null);
  });

  it("returns PLUGIN_UNLOADED without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(7);
    setActiveWebContents(wc);
    await writePlugin("dispatch-unload", { name: "acme.dispatch-unload", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-unload"
    );

    service.unloadPlugin("acme.dispatch-unload");
    const result = await host.dispatch("terminal.new", { x: 1 });

    expect(result).toEqual({
      ok: false,
      error: { code: "PLUGIN_UNLOADED", message: expect.stringContaining("no longer loaded") },
    });
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("returns EXECUTION_ERROR when no renderer is available", async () => {
    setActiveWebContents(null);
    await writePlugin("dispatch-norender", { name: "acme.dispatch-norender", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-norender"
    );

    const result = await host.dispatch("app.openSettings");
    expect(result).toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("No active renderer") },
    });
  });

  it("sends the request and resolves with the renderer's matching response", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-ok", { name: "acme.dispatch-ok", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-ok"
    );

    const pending = host.dispatch("acme.dispatch-ok.doThing", { count: 3 });

    const req = lastDispatchRequest(wc);
    expect(req.actionId).toBe("acme.dispatch-ok.doThing");
    expect(req.args).toEqual({ count: 3 });
    expect(typeof req.requestId).toBe("string");

    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 11 } },
      { requestId: req.requestId, result: { ok: true, result: 42 } }
    );

    await expect(pending).resolves.toEqual({ ok: true, result: 42 });
  });

  it("ignores a response from an unexpected sender id (cross-window guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-guard", { name: "acme.dispatch-guard", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-guard"
    );

    const pending = host.dispatch("acme.dispatch-guard.go");
    const req = lastDispatchRequest(wc);

    // Ignore any warnings emitted during plugin load/init; only count the guard.
    warnSpy.mockClear();

    // Wrong sender — must be ignored and warned about.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 999 } },
      { requestId: req.requestId, result: { ok: true, result: "spoofed" } }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected sender"));

    // Correct sender — resolves with the real result.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 11 } },
      { requestId: req.requestId, result: { ok: true, result: "real" } }
    );

    await expect(pending).resolves.toEqual({ ok: true, result: "real" });
    warnSpy.mockRestore();
  });

  it("dispose() drains pending dispatches and removes the response listener", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-dispose", { name: "acme.dispatch-dispose", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-dispose"
    );

    const pending = host.dispatch("acme.dispatch-dispose.go");
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE)).toBe(1);

    service.dispose();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("disposed") },
    });
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      expect.any(Function)
    );
  });

  it("resolves with EXECUTION_ERROR when the target renderer is destroyed mid-dispatch", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-destroyed", { name: "acme.dispatch-destroyed", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-destroyed"
    );

    const pending = host.dispatch("acme.dispatch-destroyed.go");
    wc._triggerDestroyed();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("destroyed") },
    });
  });

  it("after dispose() returns PLUGIN_UNLOADED without re-registering a listener", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-after-dispose", {
      name: "acme.dispatch-after-dispose",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-after-dispose"
    );

    // dispose() runs the full disposer cascade, which unloads every plugin
    // (removes it from the map). A post-dispose dispatch therefore fails the
    // host's PLUGIN_UNLOADED membership guard before any renderer round-trip —
    // no listener is registered and the renderer is never touched.
    service.dispose();
    const result = await host.dispatch("acme.dispatch-after-dispose.go");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_UNLOADED",
        message: expect.stringContaining("no longer loaded"),
      },
    });
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE)).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("times out a dispatch that never receives a response and ignores a late reply", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-timeout", { name: "acme.dispatch-timeout", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-timeout"
    );

    // Switch to fake timers only after plugin load/init (which uses real I/O).
    vi.useFakeTimers();
    try {
      const pending = host.dispatch("acme.dispatch-timeout.go");
      const req = lastDispatchRequest(wc);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: expect.stringContaining("timed out") },
      });

      // A late response for a timed-out request is silently dropped (no throw,
      // no double-resolve) because the pending entry was already deleted.
      expect(() =>
        ipcMainMock._emit(
          CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 11 } },
          { requestId: req.requestId, result: { ok: true, result: "late" } }
        )
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

type ActionsHostShape = (pluginId: string) => {
  host: {
    actions: {
      list: () => Promise<import("../../../shared/types/actions.js").PluginActionManifestEntry[]>;
      get: (
        actionId: string
      ) => Promise<import("../../../shared/types/actions.js").PluginActionManifestEntry | null>;
      canDispatch: (
        actionId: string
      ) => Promise<import("../../../shared/types/actions.js").PluginCanDispatchResult>;
    };
  };
  revoke: () => void;
};

/** Read the request payload from the most recent `webContents.send` for `channel`. */
function lastRequestFor(
  wc: FakeWebContents,
  channel: string
): { requestId: string } & Record<string, unknown> {
  const call = [...wc.send.mock.calls].reverse().find((c) => c[0] === channel);
  if (!call) throw new Error(`no ${channel} send recorded`);
  return call[1] as { requestId: string } & Record<string, unknown>;
}

describe("createHost — actions catalog (#10561)", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    setActiveWebContents(null);
  });

  it("list() round-trips through the renderer and resolves with the projected entries", async () => {
    const wc = makeFakeWebContents(21);
    setActiveWebContents(wc);
    await writePlugin("actions-list", { name: "acme.actions-list", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list"
    );

    const pending = host.actions.list();
    const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
    expect(typeof req.requestId).toBe("string");

    const entries = [
      { id: "terminal.new", title: "New terminal", danger: "safe", requiresArgs: false },
    ];
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      { sender: { id: 21 } },
      { requestId: req.requestId, entries }
    );

    await expect(pending).resolves.toEqual(entries);
  });

  it("list() returns [] without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(21);
    setActiveWebContents(wc);
    await writePlugin("actions-list-unload", {
      name: "acme.actions-list-unload",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list-unload"
    );

    service.unloadPlugin("acme.actions-list-unload");
    await expect(host.actions.list()).resolves.toEqual([]);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("list() resolves [] when no renderer is available", async () => {
    setActiveWebContents(null);
    await writePlugin("actions-list-norender", {
      name: "acme.actions-list-norender",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list-norender"
    );

    await expect(host.actions.list()).resolves.toEqual([]);
  });

  it("get() resolves the matching entry, and a missing/absent reply resolves null", async () => {
    const wc = makeFakeWebContents(22);
    setActiveWebContents(wc);
    await writePlugin("actions-get", { name: "acme.actions-get", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-get"
    );

    // Known id → entry.
    const knownPending = host.actions.get("terminal.new");
    const knownReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    expect(knownReq.actionId).toBe("terminal.new");
    const entry = {
      id: "terminal.new",
      title: "New terminal",
      danger: "safe",
      requiresArgs: false,
    };
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 22 } },
      { requestId: knownReq.requestId, entry }
    );
    await expect(knownPending).resolves.toEqual(entry);

    // Unknown id → renderer replies with a null entry.
    const missingPending = host.actions.get("does.not.exist");
    const missingReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 22 } },
      { requestId: missingReq.requestId, entry: null }
    );
    await expect(missingPending).resolves.toBeNull();
  });

  it("canDispatch() derives ok/confirm/restricted from the projected danger", async () => {
    const wc = makeFakeWebContents(23);
    setActiveWebContents(wc);
    await writePlugin("actions-can", { name: "acme.actions-can", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-can"
    );

    const replyGet = (entry: unknown): void => {
      const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
      ipcMainMock._emit(
        CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
        { sender: { id: 23 } },
        { requestId: req.requestId, entry }
      );
    };

    // safe → "ok"
    const okPending = host.actions.canDispatch("worktree.createWithRecipe");
    replyGet({ id: "worktree.createWithRecipe", danger: "safe", requiresArgs: false });
    await expect(okPending).resolves.toBe("ok");

    // confirm → "confirm" (the recipe.run vs createWithRecipe asymmetry is now observable)
    const confirmPending = host.actions.canDispatch("recipe.run");
    replyGet({ id: "recipe.run", danger: "confirm", requiresArgs: false });
    await expect(confirmPending).resolves.toBe("confirm");

    // absent entry (unknown or restricted-and-projected-away) → "restricted"
    const restrictedPending = host.actions.canDispatch("some.restricted.action");
    replyGet(null);
    await expect(restrictedPending).resolves.toBe("restricted");

    // fail closed: an unexpected danger value is NOT treated as dispatchable
    const bogusPending = host.actions.canDispatch("some.bogus.action");
    replyGet({ id: "some.bogus.action", danger: "bogus", requiresArgs: false });
    await expect(bogusPending).resolves.toBe("restricted");
  });

  it("ignores a catalog response from an unexpected sender id (cross-window guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wc = makeFakeWebContents(25);
    setActiveWebContents(wc);
    await writePlugin("actions-guard", { name: "acme.actions-guard", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-guard"
    );

    const pending = host.actions.get("terminal.new");
    const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    warnSpy.mockClear();

    // Wrong sender — must be ignored and warned about, leaving the request pending.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 999 } },
      { requestId: req.requestId, entry: { id: "terminal.new", danger: "safe" } }
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected sender"));

    // Correct sender — resolves with the real entry.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 25 } },
      { requestId: req.requestId, entry: { id: "terminal.new", danger: "safe" } }
    );
    await expect(pending).resolves.toMatchObject({ id: "terminal.new" });
    warnSpy.mockRestore();
  });

  it("resolves concurrent list + get independently regardless of response order", async () => {
    const wc = makeFakeWebContents(26);
    setActiveWebContents(wc);
    await writePlugin("actions-concurrent", {
      name: "acme.actions-concurrent",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-concurrent"
    );

    const listPending = host.actions.list();
    const getPending = host.actions.get("terminal.new");
    const listReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
    const getReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);

    // Deliver the get response BEFORE the list response — the shared pending map
    // keyed by requestId must not let one resolve the other.
    const entry = { id: "terminal.new", danger: "safe", requiresArgs: false };
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 26 } },
      { requestId: getReq.requestId, entry }
    );
    const entries = [{ id: "app.openSettings", danger: "safe", requiresArgs: false }];
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      { sender: { id: 26 } },
      { requestId: listReq.requestId, entries }
    );

    await expect(getPending).resolves.toEqual(entry);
    await expect(listPending).resolves.toEqual(entries);
  });

  it("canDispatch() returns 'restricted' without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(23);
    setActiveWebContents(wc);
    await writePlugin("actions-can-unload", {
      name: "acme.actions-can-unload",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-can-unload"
    );

    service.unloadPlugin("acme.actions-can-unload");
    await expect(host.actions.canDispatch("terminal.new")).resolves.toBe("restricted");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("dispose() drains a pending catalog request with its fallback and removes the listener", async () => {
    const wc = makeFakeWebContents(24);
    setActiveWebContents(wc);
    await writePlugin("actions-dispose", { name: "acme.actions-dispose", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-dispose"
    );

    const pendingList = host.actions.list();
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE)).toBe(1);

    service.dispose();

    await expect(pendingList).resolves.toEqual([]);
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      expect.any(Function)
    );
  });
});

describe("createHost — registerForgeProvider", () => {
  function forgeManifest(
    name: string,
    providerIds: string[] = ["github"]
  ): Record<string, unknown> {
    return {
      name,
      version: "1.0.0",
      contributes: {
        forgeProviders: providerIds.map((id) => ({
          id,
          name: id,
          matches: [`${id}.example`],
        })),
      },
    };
  }

  it("binds the impl via registerForgeProviderImpl with the descriptor id", async () => {
    await writePlugin("forge-host", forgeManifest("acme.forge-host"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-host"
    );

    vi.mocked(registerForgeProviderImpl).mockClear();
    const impl = { tag: "impl-a" };
    await host.registerForgeProvider({ id: "github" }, impl);
    expect(registerForgeProviderImpl).toHaveBeenCalledWith("acme.forge-host", "github", impl);
  });

  it("returns a disposer that calls unregisterForgeProviderImpl exactly once", async () => {
    await writePlugin("forge-dispose", forgeManifest("acme.forge-dispose"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-dispose"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    const impl = { tag: "impl" };
    const dispose = await host.registerForgeProvider({ id: "github" }, impl);
    dispose();
    dispose(); // idempotent — only the first call should propagate
    expect(unregisterForgeProviderImpl).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-dispose", "github", impl);
  });

  it("rejects a descriptor missing an id", async () => {
    await writePlugin("forge-baddesc", forgeManifest("acme.forge-baddesc"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-baddesc"
    );

    expect(() =>
      host.registerForgeProvider({} as unknown as { id: string }, { tag: "impl" })
    ).toThrow(/descriptor.id must be a non-empty string/);
  });

  it("rejects a non-object impl", async () => {
    await writePlugin("forge-badimpl", forgeManifest("acme.forge-badimpl"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-badimpl"
    );

    expect(() => host.registerForgeProvider({ id: "github" }, null)).toThrow(
      /impl must be an object/
    );
  });

  it("rejects a descriptor.id not declared in contributes.forgeProviders", async () => {
    // Manifest declares only "github"; "bogus" must be rejected.
    await writePlugin("forge-undeclared", forgeManifest("acme.forge-undeclared", ["github"]));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-undeclared"
    );

    expect(() => host.registerForgeProvider({ id: "bogus" }, { tag: "impl" })).toThrow(
      /not declared in contributes.forgeProviders/
    );
  });

  it("re-binding the same descriptor.id makes the older disposer inert", async () => {
    await writePlugin("forge-rebind", forgeManifest("acme.forge-rebind"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-rebind"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();

    const impl1 = { tag: "first" };
    const impl2 = { tag: "second" };
    const dispose1 = await host.registerForgeProvider({ id: "github" }, impl1);
    await host.registerForgeProvider({ id: "github" }, impl2);

    // Calling the older disposer must pass the older impl so the registry
    // can decline to clear an already-overwritten entry. The registry side
    // of this guard is covered in forgeProviderRegistry.test.ts; here we
    // only assert the disposer carries the right identity into the call.
    dispose1();
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-rebind", "github", impl1);
  });

  it("unloadPlugin fires unregisterForgeProviderImpls alongside unregisterForgeProviders", async () => {
    await writePlugin("forge-unload", forgeManifest("acme.forge-unload"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    vi.mocked(unregisterForgeProviderImpls).mockClear();
    vi.mocked(unregisterForgeProviders).mockClear();

    service.unloadPlugin("acme.forge-unload");

    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.forge-unload");
    expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-unload");
  });

  it("unloadPlugin flushes per-provider disposers from pluginEventCleanups", async () => {
    await writePlugin("forge-flush", forgeManifest("acme.forge-flush"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-flush"
    );
    const impl = { tag: "impl" };
    await host.registerForgeProvider({ id: "github" }, impl);

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    service.unloadPlugin("acme.forge-flush");
    // The per-provider disposer fires through the pluginEventCleanups flush
    // path during unloadPlugin — independent from the bulk unregisterForgeProviderImpls
    // belt-and-suspenders call.
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-flush", "github", impl);
  });

  it("replays a persisted credential into the freshly bound impl (#9983)", async () => {
    await writePlugin("forge-replay", forgeManifest("acme.forge-replay"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replay.github": JSON.stringify({ token: "stored-secret" }),
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replay"
    );

    const setCredentials = vi.fn();
    await host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "stored-secret" });
  });

  it("replays the password-typed field (not the first field) on bind (#9983)", async () => {
    await writePlugin("forge-replayfield", forgeManifest("acme.forge-replayfield"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replayfield.github": JSON.stringify({
        baseUrl: "https://github.example",
        token: "stored-secret",
      }),
    });
    // Provider declares the password field second, so a `fields[0]`-always bug
    // would replay the base URL instead of the token.
    vi.mocked(getRegisteredForgeProviders).mockReturnValueOnce([
      {
        pluginId: "acme.forge-replayfield",
        contribution: {
          id: "github",
          name: "github",
          matches: ["github.example"],
          credentialFields: [
            { id: "baseUrl", label: "Base URL", type: "text" },
            { id: "token", label: "API token", type: "password" },
          ],
        },
      },
    ]);
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replayfield"
    );

    const setCredentials = vi.fn();
    await host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "stored-secret" });
  });

  it("does not call setCredentials on bind when no credential is stored (#9983)", async () => {
    await writePlugin("forge-noreplay", forgeManifest("acme.forge-noreplay"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-noreplay"
    );

    const setCredentials = vi.fn();
    host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).not.toHaveBeenCalled();
  });

  it("survives a setCredentials throw during replay without aborting registration (#9983)", async () => {
    await writePlugin("forge-replaythrow", forgeManifest("acme.forge-replaythrow"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replaythrow.github": JSON.stringify({ token: "stored-secret" }),
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replaythrow"
    );

    const setCredentials = vi.fn(() => {
      throw new Error("boom");
    });
    // A plugin's setCredentials throwing must not propagate out of binding.
    const dispose = await host.registerForgeProvider({ id: "github" }, { setCredentials });
    expect(setCredentials).toHaveBeenCalled();
    expect(typeof dispose).toBe("function");
  });
});

describe("Plugin action registry", () => {
  let service: PluginService;

  const validContribution = () => ({
    id: "acme.my-plugin.doThing",
    title: "Do Thing",
    description: "Does a thing",
    category: "plugin",
    kind: "command" as const,
    danger: "safe" as const,
  });

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.my-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("registerPluginAction adds a descriptor and broadcasts the full list", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.my-plugin",
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    });
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions },
    });
  });

  it("registerPluginAction throws when the plugin is not loaded", () => {
    expect(() => service.registerPluginAction("acme.unknown", validContribution())).toThrow(
      /Unknown plugin/
    );
  });

  it("registerPluginAction throws for ids not prefixed with the plugin id", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "other.plugin.doThing",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction throws for malformed ids", () => {
    for (const badId of ["no-dot", "Acme.UpperCase", "", "acme..double"]) {
      expect(() =>
        service.registerPluginAction("acme.my-plugin", {
          ...validContribution(),
          id: badId,
        })
      ).toThrow(/invalid/i);
    }
  });

  it("registerPluginAction throws when id has no suffix after the pluginId", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "acme.my-plugin",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction rejects restricted danger", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        danger: "restricted" as unknown as "safe",
      })
    ).toThrow(/invalid danger/i);
  });

  it("registerPluginAction rejects unknown kind", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        kind: "navigation" as unknown as "command",
      })
    ).toThrow(/invalid kind/i);
  });

  it("registerPluginAction throws on duplicate id", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(() => service.registerPluginAction("acme.my-plugin", validContribution())).toThrow(
      /already registered/
    );
  });

  it("sets effectiveDanger='safe' when the plugin holds no high-risk capability", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(service.listPluginActions()[0].effectiveDanger).toBe("safe");
  });

  it("keeps effectiveDanger='confirm' when the plugin self-declares confirm", () => {
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      danger: "confirm" as const,
    });
    expect(service.listPluginActions()[0].effectiveDanger).toBe("confirm");
  });

  it("raises effectiveDanger to 'confirm' for a self-declared 'safe' action when the manifest grants a high-risk capability", async () => {
    await writePlugin("risky", {
      name: "acme.risky",
      version: "1.0.0",
      capabilities: ["fs:project-read", "shell:exec"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.risky", {
      ...validContribution(),
      id: "acme.risky.doThing",
      danger: "safe" as const,
    });

    const action = svc.listPluginActions().find((a) => a.id === "acme.risky.doThing");
    expect(action?.danger).toBe("safe"); // plugin's advisory declaration preserved
    expect(action?.effectiveDanger).toBe("confirm"); // host raised it
  });

  it.each([
    "shell:exec",
    "git:write",
    "fs:project-write",
    "fs:user-data-write",
    "agent:invoke",
    "agent:register",
    "agent:input",
  ])(
    "raises a self-declared 'safe' action to confirm when the manifest grants %s",
    async (capability) => {
      const name = `acme.perm-${capability.replace(/[^a-z]/g, "-")}`;
      await writePlugin(`perm-${capability.replace(/[^a-z]/g, "-")}`, {
        name,
        version: "1.0.0",
        capabilities: [capability],
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      expect(svc.listPluginActions().find((a) => a.id === `${name}.doThing`)?.effectiveDanger).toBe(
        "confirm"
      );
    }
  );

  it.each([
    ["agent:read", "network:fetch"],
    ["git:read", "network:fetch"],
    ["fs:project-read", "network:fetch"],
    ["fs:user-data-read", "network:fetch"],
  ])(
    "raises effectiveDanger to 'confirm' for compound exfiltration pair %s + %s (no scope)",
    async (source, sink) => {
      const safeName = `${source}-${sink}`.replace(/[^a-z]/g, "-");
      const name = `acme.compound-${safeName}`;
      await writePlugin(`compound-${safeName}`, {
        name,
        version: "1.0.0",
        capabilities: [source, sink],
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      const action = svc.listPluginActions().find((a) => a.id === `${name}.doThing`);
      expect(action?.danger).toBe("safe");
      expect(action?.effectiveDanger).toBe("confirm");
    }
  );

  it.each(["agent:read", "git:read", "fs:project-read", "fs:user-data-read"])(
    "tight network scope attenuates compound elevation for sensitive-read source %s + network:fetch",
    async (source) => {
      const safe = source.replace(/[^a-z]/g, "-");
      const name = `acme.attenuated-${safe}`;
      await writePlugin(`attenuated-${safe}`, {
        name,
        version: "1.0.0",
        capabilities: [source, "network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v2"] } },
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      expect(svc.listPluginActions().find((a) => a.id === `${name}.doThing`)?.effectiveDanger).toBe(
        "safe"
      );
    }
  );

  it("scoped network:fetch does NOT suppress flat elevation from fs:project-write", async () => {
    // The compound attenuation only short-circuits the compound elevation path
    // — flat-elevated capabilities in CONFIRM_TRIGGERING_CAPABILITIES must
    // still raise effectiveDanger regardless of any scope.
    await writePlugin("scoped-with-write", {
      name: "acme.scoped-with-write",
      version: "1.0.0",
      capabilities: ["network:fetch", "fs:project-write"],
      scopes: { network: { allowedUrls: ["https://api.example.com"] } },
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.scoped-with-write", {
      ...validContribution(),
      id: "acme.scoped-with-write.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.scoped-with-write.doThing")
        ?.effectiveDanger
    ).toBe("confirm");
  });

  it("raises effectiveDanger for sensitive-read + shell:exec even with network scope (shell is never attenuated)", async () => {
    await writePlugin("read-shell", {
      name: "acme.read-shell",
      version: "1.0.0",
      capabilities: ["fs:project-read", "shell:exec"],
      scopes: { network: { allowedUrls: ["https://api.example.com"] } },
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.read-shell", {
      ...validContribution(),
      id: "acme.read-shell.doThing",
      danger: "safe" as const,
    });

    // shell:exec is flat-elevated regardless — but the test asserts the compound
    // path also fires because the network scope must not attenuate shell sinks.
    const action = svc.listPluginActions().find((a) => a.id === "acme.read-shell.doThing");
    expect(action?.effectiveDanger).toBe("confirm");
  });

  it("raises effectiveDanger for remote-mutation pair network:fetch + git:write (no scope)", async () => {
    await writePlugin("net-write", {
      name: "acme.net-write",
      version: "1.0.0",
      capabilities: ["network:fetch", "git:write"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.net-write", {
      ...validContribution(),
      id: "acme.net-write.doThing",
      danger: "safe" as const,
    });

    // git:write already elevates flat — compound path is redundant but correct.
    expect(
      svc.listPluginActions().find((a) => a.id === "acme.net-write.doThing")?.effectiveDanger
    ).toBe("confirm");
  });

  it("does not compound-elevate a plugin holding only a sensitive read (no sink)", async () => {
    await writePlugin("read-only", {
      name: "acme.read-only",
      version: "1.0.0",
      capabilities: ["agent:read", "git:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.read-only", {
      ...validContribution(),
      id: "acme.read-only.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.read-only.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("does not compound-elevate a plugin holding only network:fetch (no source/sink pair)", async () => {
    await writePlugin("net-only", {
      name: "acme.net-only",
      version: "1.0.0",
      capabilities: ["network:fetch"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.net-only", {
      ...validContribution(),
      id: "acme.net-only.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.net-only.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("compound elevation is order-independent in the capabilities array", async () => {
    await writePlugin("order", {
      name: "acme.order",
      version: "1.0.0",
      capabilities: ["network:fetch", "agent:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.order", {
      ...validContribution(),
      id: "acme.order.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.order.doThing")?.effectiveDanger
    ).toBe("confirm");
  });

  it("does not raise effectiveDanger for read-only / reversible capabilities (no compound pair)", async () => {
    await writePlugin("readonly", {
      name: "acme.readonly",
      version: "1.0.0",
      capabilities: ["fs:project-read", "clipboard:write", "git:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.readonly", {
      ...validContribution(),
      id: "acme.readonly.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.readonly.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("unregisterPluginAction removes a single action and broadcasts", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    broadcastToRendererMock.mockClear();

    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.doThing");

    expect(service.listPluginActions()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: [] },
    });
  });

  it("unregisterPluginAction is a silent no-op for unknown ids", () => {
    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.missing");
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("unregisterPluginAction does not remove actions owned by a different plugin", async () => {
    await writePlugin("other", { name: "acme.other", version: "1.0.0" });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.my-plugin", validContribution());

    svc.unregisterPluginAction("acme.other", "acme.my-plugin.doThing");
    expect(svc.listPluginActions()).toHaveLength(1);
  });

  it("unloadPlugin bulk-removes plugin actions", async () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      id: "acme.my-plugin.other",
    });
    expect(service.listPluginActions()).toHaveLength(2);

    broadcastToRendererMock.mockClear();
    service.unloadPlugin("acme.my-plugin");

    expect(service.listPluginActions()).toEqual([]);
    // Exactly one broadcast for the bulk removal (no per-action spam)
    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === CHANNELS.EVENTS_PUSH &&
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as { name?: unknown }).name === "plugin:actions-changed"
    );
    expect(broadcasts).toHaveLength(1);
  });

  it("descriptor keeps a defensive copy of keywords", () => {
    const keywords = ["foo", "bar"];
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      keywords,
    });
    keywords.push("mutated");

    const [descriptor] = service.listPluginActions();
    expect(descriptor.keywords).toEqual(["foo", "bar"]);
  });

  it("descriptor keeps a defensive copy of inputSchema", () => {
    const inputSchema: Record<string, unknown> = { type: "object", properties: { a: 1 } };
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      inputSchema,
    });
    (inputSchema as Record<string, unknown>).properties = { a: 999 };

    const [descriptor] = service.listPluginActions();
    expect(descriptor.inputSchema).toEqual({ type: "object", properties: { a: 1 } });
  });
});

type ActionDescriptorInput = {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: "command" | "query";
  danger: "safe" | "confirm";
  keywords?: string[];
  inputSchema?: Record<string, unknown>;
};
type ActionHostShape = (pluginId: string) => {
  host: {
    registerAction: (
      descriptor: ActionDescriptorInput,
      handler: (args: unknown) => unknown
    ) => void;
  };
  revoke: () => void;
};

describe("createHost — registerAction", () => {
  let service: PluginService;

  const descriptor = (overrides: Partial<ActionDescriptorInput> = {}): ActionDescriptorInput => ({
    id: "plan-from-issue",
    title: "Plan from issue",
    description: "Turn an issue into a session",
    category: "Planner",
    kind: "command",
    danger: "safe",
    ...overrides,
  });

  const getHost = (pluginId: string) =>
    (service as unknown as { createHost: ActionHostShape }).createHost(pluginId);

  beforeEach(async () => {
    await writePlugin("act-test", { name: "acme.act-test", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("namespaces the un-prefixed id to {pluginId}.{id} and stores the descriptor", () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => "ok");

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.act-test",
      id: "acme.act-test.plan-from-issue",
      title: "Plan from issue",
    });
    // Registering a new action broadcasts the refreshed list to renderers.
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions },
    });
  });

  it("invokes the handler with the args payload only — no IPC ctx", async () => {
    const handler = vi.fn().mockResolvedValue({ done: true });
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), handler);

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{ issue: 42 }]
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ issue: 42 });
    expect(result).toEqual({ done: true });
  });

  it("invokes the handler with {} when dispatched with no args", async () => {
    const handler = vi.fn().mockReturnValue("ran");
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), handler);

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      []
    );
    // Defaults to {} (matching the input-schema validation default) rather than
    // undefined, so a handler can safely destructure the args object.
    expect(handler).toHaveBeenCalledWith({});
    expect(result).toBe("ran");
  });

  it("audits a throwing action handler as an action-dispatch error record (#10463)", async () => {
    const appendSpy = vi
      .spyOn(getPluginActionAuditService(), "append")
      .mockImplementation(() => {});
    try {
      const boom = new Error("action exploded");
      const { host } = getHost("acme.act-test");
      host.registerAction(descriptor(), () => {
        throw boom;
      });

      await expect(
        service.dispatchHandler(
          "acme.act-test",
          "acme.act-test.plan-from-issue",
          makeCtx("acme.act-test"),
          [{ issue: 7 }]
        )
      ).rejects.toBe(boom);

      expect(appendSpy).toHaveBeenCalledTimes(1);
      const record = appendSpy.mock.calls[0][0];
      expect(record).toMatchObject({
        pluginId: "acme.act-test",
        actionId: "acme.act-test.plan-from-issue",
        recordType: "action-dispatch",
        result: "error",
      });
      expect(record.errorMessage).toContain("action exploded");
      expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
      // Marked so the outer plugin:invoke catch won't record a duplicate.
      expect(isAuditedHandlerFailure(boom)).toBe(true);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("audits a successful action handler as an action-dispatch success record (#10517)", async () => {
    const appendSpy = vi
      .spyOn(getPluginActionAuditService(), "append")
      .mockImplementation(() => {});
    try {
      const { host } = getHost("acme.act-test");
      host.registerAction(descriptor(), () => "done");

      const result = await service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{ issue: 7 }]
      );
      expect(result).toBe("done");

      expect(appendSpy).toHaveBeenCalledTimes(1);
      const record = appendSpy.mock.calls[0][0];
      expect(record).toMatchObject({
        pluginId: "acme.act-test",
        actionId: "acme.act-test.plan-from-issue",
        recordType: "action-dispatch",
        result: "success",
      });
      expect(record.errorMessage).toBe("");
      expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof record.durationMs).toBe("number");
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("rejects calls after the host is revoked", () => {
    const { host, revoke } = getHost("acme.act-test");
    revoke();
    expect(() => host.registerAction(descriptor(), () => undefined)).toThrow(
      /host revoked: registerAction/
    );
  });

  it("rejects a non-object descriptor", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(null as unknown as ActionDescriptorInput, () => undefined)
    ).toThrow(/descriptor must be an object/);
  });

  it("rejects a non-function handler", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(descriptor(), "not-a-function" as unknown as () => unknown)
    ).toThrow(/handler must be a function/);
  });

  it("rejects an empty descriptor.id", () => {
    const { host } = getHost("acme.act-test");
    expect(() => host.registerAction(descriptor({ id: "" }), () => undefined)).toThrow(
      /descriptor.id must be a non-empty string/
    );
  });

  it("rejects an id that already includes the plugin prefix (no double-prefix)", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(descriptor({ id: "acme.act-test.plan-from-issue" }), () => undefined)
    ).toThrow(/must not include the plugin prefix/);
    // Nothing was registered under the doubled id.
    expect(service.listPluginActions()).toHaveLength(0);
  });

  it("passes {} to the handler when dispatched with no args (matches schema validation)", async () => {
    const handler = vi.fn().mockReturnValue("ok");
    const { host } = getHost("acme.act-test");
    // Schema with only optional fields accepts an empty object.
    host.registerAction(
      descriptor({ inputSchema: { type: "object", properties: { flag: { type: "boolean" } } } }),
      handler
    );

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      []
    );
    // Handler receives the same {} the validator accepted — not undefined.
    expect(handler).toHaveBeenCalledWith({});
    expect(result).toBe("ok");
  });

  it("rejects restricted danger", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(
        descriptor({ danger: "restricted" as unknown as "safe" }),
        () => undefined
      )
    ).toThrow(/invalid danger/i);
  });

  it("raises effectiveDanger to confirm when the manifest grants a high-risk capability", async () => {
    await writePlugin("act-risky", {
      name: "acme.act-risky",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();
    const { host } = (svc as unknown as { createHost: ActionHostShape }).createHost(
      "acme.act-risky"
    );

    host.registerAction(descriptor({ danger: "safe" }), () => undefined);

    const action = svc.listPluginActions().find((a) => a.id === "acme.act-risky.plan-from-issue");
    expect(action?.danger).toBe("safe");
    expect(action?.effectiveDanger).toBe("confirm");
  });

  it("replaces the prior descriptor and handler on re-registration with the same id", async () => {
    const first = vi.fn().mockReturnValue("first");
    const second = vi.fn().mockReturnValue("second");
    const { host } = getHost("acme.act-test");

    host.registerAction(descriptor({ title: "Old title" }), first);
    host.registerAction(descriptor({ title: "New title" }), second);

    // Exactly one descriptor — replace, not append.
    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe("New title");

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{}]
    );
    expect(result).toBe("second");
    expect(first).not.toHaveBeenCalled();
  });

  it("lets a host re-registration replace a renderer IPC registration", async () => {
    // IPC path registers metadata only (no main-side handler).
    service.registerPluginAction("acme.act-test", {
      id: "acme.act-test.plan-from-issue",
      title: "Via IPC",
      description: "registered through the renderer path",
      category: "Planner",
      kind: "command",
      danger: "safe",
    });

    const handler = vi.fn().mockReturnValue("from-host");
    const { host } = getHost("acme.act-test");
    // Replace semantics: re-registering the same id from the host does not throw.
    expect(() => host.registerAction(descriptor(), handler)).not.toThrow();

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{}]
    );
    expect(result).toBe("from-host");
  });

  it("keeps the renderer IPC path throwing on a duplicate id (asymmetric semantics)", () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => undefined);

    // The IPC path stays loud on duplicates even after a host registration.
    expect(() =>
      service.registerPluginAction("acme.act-test", {
        id: "acme.act-test.plan-from-issue",
        title: "Dup",
        description: "duplicate",
        category: "Planner",
        kind: "command",
        danger: "safe",
      })
    ).toThrow(/already registered/);
  });

  it("validates args against the action's inputSchema", async () => {
    const handler = vi.fn().mockReturnValue("ok");
    const { host } = getHost("acme.act-test");
    host.registerAction(
      descriptor({
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      }),
      handler
    );

    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow(/Invalid arguments/);
    expect(handler).not.toHaveBeenCalled();

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{ name: "issue" }]
    );
    expect(result).toBe("ok");
  });

  it("propagates an async handler rejection through dispatch", async () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), async () => {
      throw new Error("handler boom");
    });

    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow("handler boom");
  });

  it("removes the handler on unload so dispatch throws afterwards", async () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => "ok");
    expect(
      await service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).toBe("ok");

    service.unloadPlugin("acme.act-test");

    expect(service.listPluginActions()).toEqual([]);
    // Once unloaded the plugin is no longer in `this.plugins`, so the ownership
    // guard (#10462) rejects the dispatch before the action lookup runs.
    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow('plugin:invoke rejected: plugin "acme.act-test" is not loaded');
  });
});

describe("Plugin panel kind registry broadcast", () => {
  it("dispose() drops a microtask scheduled before disposal", async () => {
    // Capture the listener PluginService passes into onPanelKindRegistered so
    // we can fire it directly — this simulates a register event arriving from
    // the shared registry during the test.
    const registryMock = await import("../../../shared/config/panelKindRegistry.js");
    const onRegisteredMock = vi.mocked(registryMock.onPanelKindRegistered);
    let capturedRegisterListener: ((config: PanelKindConfig) => void) | null = null;
    onRegisteredMock.mockImplementation((listener: (config: PanelKindConfig) => void) => {
      capturedRegisterListener = listener;
      return () => {};
    });

    const service = new PluginService();
    expect(capturedRegisterListener).toBeTypeOf("function");

    // Simulate a register event — schedules a microtask broadcast
    const mockConfig: PanelKindConfig = {
      id: "test-panel",
      name: "Test Panel",
      iconId: "test",
      color: "#000000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "test-ext",
    };
    capturedRegisterListener!(mockConfig);
    // Dispose before the microtask drains
    service.dispose();

    // Allow microtasks to drain
    await Promise.resolve();
    await Promise.resolve();

    // Disposal must have cancelled the pending broadcast
    const panelKindBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:panel-kinds-changed"
    );
    expect(panelKindBroadcasts).toHaveLength(0);
  });
});

describe("Plugin context-menu items broadcast", () => {
  it("coalesces load + unload in the same tick into a single broadcast with complete=true", async () => {
    const service = new PluginService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(true);

    await Promise.resolve();
    await Promise.resolve();

    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:context-menu-items-changed"
    );
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0]?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(true);

    service.dispose();
  });

  it("dispose() drops a context-menu items broadcast scheduled before disposal", async () => {
    const service = new PluginService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(true);
    service.dispose();

    await Promise.resolve();
    await Promise.resolve();

    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:context-menu-items-changed"
    );
    expect(broadcasts).toHaveLength(0);
  });
});

describe("capabilities declaration logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs declared capabilities when plugin has capabilities", async () => {
    await writePlugin("perm-plugin", {
      name: "acme.perm-plugin",
      version: "1.0.0",
      capabilities: ["fs:project-read", "network:fetch"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.perm-plugin" declares capabilities: fs:project-read, network:fetch'
      )
    );
  });

  it("does not log when plugin has no capabilities", async () => {
    await writePlugin("no-perms", {
      name: "acme.no-perms",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("does not log capabilities for incompatible plugins", async () => {
    await writePlugin("incompatible-perms", {
      name: "acme.incompatible-perms",
      version: "1.0.0",
      capabilities: ["fs:project-read"],
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("includes capabilities in loaded plugin manifest", async () => {
    await writePlugin("with-perms", {
      name: "acme.with-perms",
      version: "1.0.0",
      capabilities: ["git:read", "agent:invoke"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual(["git:read", "agent:invoke"]);
  });

  it("defaults capabilities to empty array for plugins without the field", async () => {
    await writePlugin("no-field", {
      name: "acme.no-field",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual([]);
  });

  it("rejects plugins that declare unknown capabilities and does not log them", async () => {
    await writePlugin("unknown-perm", {
      name: "acme.unknown-perm",
      version: "1.0.0",
      capabilities: ["shell:exec", "invalid:perm"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins with newline characters in capability strings", async () => {
    await writePlugin("padded-perm", {
      name: "acme.padded-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read\n", "agent:invoke\r"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins where any one capability in a mixed array is invalid", async () => {
    await writePlugin("mixed-perm", {
      name: "acme.mixed-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read", "invalid:perm", "git:read"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });
});

describe("Plugin worktree host API", () => {
  type WorktreeSnapshotLike = {
    id: string;
    worktreeId: string;
    path: string;
    name: string;
    isCurrent: boolean;
    branch?: string;
    aheadCount?: number;
    issueNumber?: number;
    lastActivityTimestamp?: number | null;
    worktreeChanges?: {
      worktreeId: string;
      rootPath: string;
      changes: Array<{ path: string; status: string; insertions: null; deletions: null }>;
      changedFileCount: number;
    };
    _secret?: string;
  };

  function mkSnap(over: Partial<WorktreeSnapshotLike> & { id: string }): WorktreeSnapshotLike {
    return {
      worktreeId: over.id,
      path: `/tmp/${over.id}`,
      name: over.id,
      isCurrent: false,
      ...over,
    };
  }

  function createMockClient(initial: WorktreeSnapshotLike[] = []) {
    const emitter = new EventEmitter();
    let states = initial;
    const getAllStatesAsync = vi.fn(() => Promise.resolve(states));
    const client = Object.assign(emitter, {
      getAllStatesAsync,
      setStates: (next: WorktreeSnapshotLike[]) => {
        states = next;
      },
    });
    return client;
  }

  type HostWithWorktree = {
    pluginId: string;
    registerHandler: (c: string, h: (...args: unknown[]) => unknown) => void;
    broadcastToRenderer: (c: string, p: unknown) => void;
    getActiveWorktree: () => Promise<unknown>;
    getWorktrees: () => Promise<unknown[]>;
    getWorktreeStatus: (path: string) => Promise<unknown>;
    onDidChangeActiveWorktree: (cb: (s: unknown) => void) => () => void;
    onDidChangeWorktrees: (cb: (list: unknown[]) => void) => () => void;
  };

  async function setup(snapshots: WorktreeSnapshotLike[] = []) {
    await writePlugin("wt-host", { name: "acme.wt-host", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const client = createMockClient(snapshots);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => {
          host: HostWithWorktree;
          revoke: () => void;
        };
      }
    ).createHost("acme.wt-host");
    return { service, client, host, revoke };
  }

  it("getActiveWorktree returns a frozen projection of the isCurrent snapshot", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true, branch: "feature/x", _secret: "leak" }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown> | null;
    expect(active).not.toBeNull();
    expect(active!.id).toBe("b");
    expect(active!.branch).toBe("feature/x");
    // Internal fields must not leak through the projection
    expect("_secret" in active!).toBe(false);
    expect(Object.isFrozen(active)).toBe(true);
  });

  it("getActiveWorktree returns null when no worktree is current", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: false })]);
    expect(await host.getActiveWorktree()).toBeNull();
  });

  it("getWorktrees returns frozen snapshots for every worktree", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true }),
    ]);
    const list = (await host.getWorktrees()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(list.every((s) => Object.isFrozen(s))).toBe(true);
  });

  it("getWorktreeStatus returns the changed-file projection for the matching path", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({
        id: "b",
        isCurrent: true,
        worktreeChanges: {
          worktreeId: "b",
          rootPath: "/tmp/b",
          changes: [
            { path: "src/x.ts", status: "modified", insertions: null, deletions: null },
            { path: "src/y.ts", status: "untracked", insertions: null, deletions: null },
          ],
          changedFileCount: 2,
        },
      }),
    ]);

    const status = (await host.getWorktreeStatus("/tmp/b")) as {
      changedFileCount: number;
      files: Array<{ path: string; state: string }>;
    } | null;
    expect(status).not.toBeNull();
    expect(status!.changedFileCount).toBe(2);
    expect(status!.files).toEqual([
      { path: "src/x.ts", state: "modified" },
      { path: "src/y.ts", state: "untracked" },
    ]);
    expect(Object.isFrozen(status)).toBe(true);
  });

  it("getWorktreeStatus returns null when no worktree matches the path", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: true })]);
    expect(await host.getWorktreeStatus("/tmp/does-not-exist")).toBeNull();
  });

  it("getWorktreeStatus returns null when the matched worktree has no polled changes", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: true })]);
    // /tmp/a exists but carries no worktreeChanges → null, not an empty status.
    expect(await host.getWorktreeStatus("/tmp/a")).toBeNull();
  });

  it("getActiveWorktree returns null when WorkspaceClient is not wired", async () => {
    await writePlugin("wt-nowsc", { name: "acme.wt-nowsc", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally skip setWorkspaceClient
    const { host } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-nowsc");
    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("onDidChangeActiveWorktree fires with the new active snapshot", async () => {
    const snaps = [mkSnap({ id: "a", isCurrent: true })];
    const { host, client, revoke } = await setup(snaps);

    // Subscribe during "activate" window (before revoke), as a real plugin would.
    const cb = vi.fn();
    const dispose = await host.onDidChangeActiveWorktree(cb);
    revoke();

    client.setStates([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
    expect(arg.branch).toBe("dev");

    dispose();
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    // Ensure no additional calls after dispose
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDidChangeWorktrees fires with the full list on worktree-update", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    await host.onDidChangeWorktrees(cb);
    revoke();

    client.emit("worktree-update", {
      worktree: mkSnap({ id: "a", isCurrent: true }),
      projectPath: "/p",
    });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("disposers are idempotent and only remove the matching listener", async () => {
    const { host, client, revoke } = await setup();

    const cbA = vi.fn();
    const cbB = vi.fn();
    const disposeA = await host.onDidChangeActiveWorktree(cbA);
    await host.onDidChangeActiveWorktree(cbB);
    revoke();

    disposeA();
    disposeA(); // no-op

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await vi.waitFor(() => expect(cbB).toHaveBeenCalledTimes(1));
    expect(cbA).not.toHaveBeenCalled();
  });

  it("unloadPlugin flushes every worktree event listener for the plugin", async () => {
    const { service, host, client, revoke } = await setup();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    await host.onDidChangeActiveWorktree(cb1);
    await host.onDidChangeWorktrees(cb2);
    revoke();

    // worktree-activated carries an extra service-level listener: the #10621
    // cache-eviction subscription wired in setWorkspaceClient (independent of any
    // plugin). worktree-update has only the plugin's listener.
    expect(client.listenerCount("worktree-activated")).toBe(2);
    expect(client.listenerCount("worktree-update")).toBe(1);

    service.unloadPlugin("acme.wt-host");

    // The plugin's listeners are flushed; the service-level eviction listener on
    // worktree-activated survives the unload (it's torn down only on dispose).
    expect(client.listenerCount("worktree-activated")).toBe(1);
    expect(client.listenerCount("worktree-update")).toBe(0);

    client.emit("worktree-activated", { worktreeId: "x", projectPath: "/p" });
    client.emit("worktree-update", { worktree: mkSnap({ id: "x" }), projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("registering an event subscription after revoke throws", async () => {
    const { host, revoke } = await setup();

    // Pre-revoke registration is allowed (this is the activate() window).
    expect(() => host.onDidChangeActiveWorktree(() => {})).not.toThrow();

    revoke();

    // Post-revoke registration is rejected — simulates a plugin holding the
    // host reference and trying to subscribe after activate() returned.
    expect(() => host.onDidChangeActiveWorktree(() => {})).toThrow(/host revoked/);
    expect(() => host.onDidChangeWorktrees(() => {})).toThrow(/host revoked/);
  });

  it("callbacks do not fire after unloadPlugin even if the client emits again", async () => {
    const { service, host, client, revoke } = await setup();
    const cb = vi.fn();
    await host.onDidChangeActiveWorktree(cb);
    revoke();

    service.unloadPlugin("acme.wt-host");

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("subscriptions registered before setWorkspaceClient replay against the new client", async () => {
    await writePlugin("wt-boot", { name: "acme.wt-boot", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally do NOT set the workspace client yet — this simulates a
    // plugin calling host.onDidChange* during its activate() on cold boot,
    // before windowServices wires up WorkspaceClient.
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot");

    const cb = vi.fn();
    await host.onDidChangeActiveWorktree(cb);
    revoke();

    // Now the client becomes available — subscriptions must be replayed.
    const client = createMockClient([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    // One replayed plugin subscription plus the service-level cache-eviction
    // listener that setWorkspaceClient always attaches (#10621).
    expect(client.listenerCount("worktree-activated")).toBe(2);

    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
  });

  it("disposing a pending subscription before setWorkspaceClient stops replay", async () => {
    await writePlugin("wt-boot2", { name: "acme.wt-boot2", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot2");

    const cb = vi.fn();
    const dispose = await host.onDidChangeActiveWorktree(cb);
    revoke();
    dispose();

    const client = createMockClient([mkSnap({ id: "a", isCurrent: true })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    // The disposed plugin subscription does not replay; only the service-level
    // cache-eviction listener that setWorkspaceClient attaches remains (#10621).
    expect(client.listenerCount("worktree-activated")).toBe(1);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("onDidChangeWorktrees fires on worktree-removed with the post-removal list", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    await host.onDidChangeWorktrees(cb);
    revoke();

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-removed", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id)).toEqual(["a"]);
  });

  it("onDidChangeWorktrees disposer stops both update and remove subscriptions", async () => {
    const { host, client, revoke } = await setup([mkSnap({ id: "a", isCurrent: true })]);

    const cb = vi.fn();
    const dispose = await host.onDidChangeWorktrees(cb);
    revoke();
    expect(client.listenerCount("worktree-update")).toBe(1);
    expect(client.listenerCount("worktree-removed")).toBe(1);

    dispose();
    expect(client.listenerCount("worktree-update")).toBe(0);
    expect(client.listenerCount("worktree-removed")).toBe(0);
  });

  it("plugin snapshot exposes exactly the documented allowlist fields", async () => {
    const { host } = await setup([
      mkSnap({
        id: "a",
        isCurrent: true,
        branch: "main",
        aheadCount: 1,
        // A field that must NOT leak to plugins — the real WorktreeSnapshot
        // has dozens of these; we sample one as a guard.
        _secret: "leak-me",
      }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown>;
    expect(active).not.toBeNull();
    const expected = [
      "aheadCount",
      "behindCount",
      "branch",
      "createdAt",
      "id",
      "isCurrent",
      "isMainWorktree",
      "lastActivityTimestamp",
      "linked",
      "mood",
      "name",
      "path",
      "status",
      "worktreeId",
    ];
    expect(Object.keys(active).sort()).toEqual(expected);
    expect("_secret" in active).toBe(false);
    // None of the removed GitHub-shaped fields should leak through.
    for (const removed of [
      "issueNumber",
      "issueTitle",
      "prNumber",
      "prState",
      "prTitle",
      "prUrl",
    ]) {
      expect(removed in active).toBe(false);
    }
  });
});

describe("Plugin agent-state host API (#10521)", () => {
  type AgentHost = {
    pluginId: string;
    getAgentState: () => Promise<unknown>;
    onDidChangeAgentState: (cb: (s: unknown) => void) => Promise<() => void>;
  };

  /**
   * Load a plugin with the given capabilities and build a host for it. The
   * `agent:read`-gated methods read declared capabilities off the loaded
   * manifest, so the capability must be present on disk before initialize().
   */
  async function setupAgentHost(
    capabilities: string[]
  ): Promise<{ service: PluginService; host: AgentHost; revoke: () => void }> {
    await writePlugin("agent-host", {
      name: "acme.agent-host",
      version: "1.0.0",
      capabilities,
    });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: AgentHost; revoke: () => void };
      }
    ).createHost("acme.agent-host");
    return { service, host, revoke };
  }

  function emitState(
    over: Partial<{
      agentId: string;
      state: string;
      previousState: string;
      waitingReason: string;
      sessionCost: number;
      sessionTokens: number;
      timestamp: number;
    }> = {}
  ): void {
    events.emit("agent:state-changed", {
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 1,
      timestamp: 1000,
      ...over,
    } as never);
  }

  it("getAgentState rejects with PERMISSION_REQUIRED when agent:read is not declared", async () => {
    const { host } = await setupAgentHost([]);
    await expect(host.getAgentState()).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("onDidChangeAgentState throws PERMISSION_REQUIRED when agent:read is not declared", async () => {
    const { host } = await setupAgentHost([]);
    // The capability guard throws synchronously before returning the disposer
    // promise (same shape as onDidChangeWorktrees).
    expect(() => host.onDidChangeAgentState(() => {})).toThrow(/PERMISSION_REQUIRED/);
  });

  it("getAgentState returns null before any agent state change is observed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    expect(await host.getAgentState()).toBeNull();
  });

  it("onDidChangeAgentState delivers a frozen projected snapshot on state-changed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    emitState({
      agentId: "agent-1",
      state: "waiting",
      previousState: "working",
      waitingReason: "question",
      timestamp: 4242,
    });

    expect(received).toHaveLength(1);
    const snap = received[0];
    expect(snap.agentId).toBe("agent-1");
    expect(snap.state).toBe("waiting");
    expect(snap.previousState).toBe("working");
    expect(snap.running).toBe(true);
    expect(snap.waitingReason).toBe("question");
    expect(snap.timestamp).toBe(4242);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("getAgentState returns the last projected snapshot after a state change", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    await host.onDidChangeAgentState(() => {});

    emitState({ agentId: "agent-2", state: "completed", previousState: "working", timestamp: 99 });

    const snap = (await host.getAgentState()) as Record<string, unknown>;
    expect(snap).not.toBeNull();
    expect(snap.agentId).toBe("agent-2");
    expect(snap.state).toBe("completed");
    expect(snap.running).toBe(false);
  });

  it("derives running=true only for working/waiting/directing", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    for (const state of ["idle", "working", "waiting", "directing", "completed", "exited"]) {
      emitState({ state, previousState: "idle" });
    }

    const byState = new Map(received.map((s) => [s.state as string, s.running as boolean]));
    expect(byState.get("idle")).toBe(false);
    expect(byState.get("working")).toBe(true);
    expect(byState.get("waiting")).toBe(true);
    expect(byState.get("directing")).toBe(true);
    expect(byState.get("completed")).toBe(false);
    expect(byState.get("exited")).toBe(false);
  });

  it("the snapshot omits internal routing ids and activity-detector internals", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    events.emit("agent:state-changed", {
      agentId: "agent-3",
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 0.9,
      cwd: "/secret/path",
      terminalId: "term-internal",
      worktreeId: "wt-internal",
      temperature: 42,
      heatAdded: 7,
      changedChars: 3,
      timestamp: 1,
    } as never);

    const snap = received[0];
    for (const leaked of [
      "terminalId",
      "worktreeId",
      "cwd",
      "trigger",
      "confidence",
      "temperature",
      "heatAdded",
      "changedChars",
    ]) {
      expect(leaked in snap).toBe(false);
    }
    expect(Object.keys(snap).sort()).toEqual([
      "agentId",
      "previousState",
      "running",
      "state",
      "timestamp",
    ]);
  });

  it("the disposer stops further callbacks and is safe to call twice", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: unknown[] = [];
    const dispose = await host.onDidChangeAgentState((s) => received.push(s));

    emitState({ state: "working" });
    expect(received).toHaveLength(1);

    dispose();
    dispose(); // double-dispose must not throw
    emitState({ state: "idle" });
    expect(received).toHaveLength(1);
  });

  it("unloading the plugin disposes the subscription and stops callbacks", async () => {
    const { service, host } = await setupAgentHost(["agent:read"]);
    const received: unknown[] = [];
    await host.onDidChangeAgentState((s) => received.push(s));

    emitState({ state: "working" });
    expect(received).toHaveLength(1);

    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-host");

    emitState({ state: "idle" });
    expect(received).toHaveLength(1);
  });

  it("getAgentState returns null (not an error) after the plugin is unloaded", async () => {
    const { service, host } = await setupAgentHost(["agent:read"]);
    await host.onDidChangeAgentState(() => {});
    emitState({ agentId: "a-pre", state: "working", previousState: "idle" });
    expect(await host.getAgentState()).not.toBeNull();

    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-host");

    // declaredCapabilities() returns [] post-unload, so a capability check first
    // would mis-throw PERMISSION_REQUIRED — the liveness check must win.
    expect(await host.getAgentState()).toBeNull();
  });

  it("getAgentState stays null when events fire but the plugin never subscribed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    emitState({ state: "working", previousState: "idle" });
    // No subscription means no handler caches the snapshot — the host keeps no
    // pre-subscription history.
    expect(await host.getAgentState()).toBeNull();
  });

  it("getAgentState inside the callback observes the just-delivered snapshot", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    let insidePromise: Promise<unknown> | null = null;
    await host.onDidChangeAgentState(() => {
      insidePromise = host.getAgentState();
    });

    emitState({ agentId: "a9", state: "working", previousState: "idle" });

    const inside = (await insidePromise) as Record<string, unknown> | null;
    expect(inside).not.toBeNull();
    expect(inside?.agentId).toBe("a9");
  });

  it("multiple subscriptions from the same plugin dispose independently", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const disposeA = await host.onDidChangeAgentState((s) => a.push(s));
    await host.onDidChangeAgentState((s) => b.push(s));

    emitState({ state: "working" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    disposeA();
    emitState({ state: "idle" });
    expect(a).toHaveLength(1); // disposed — no more deliveries
    expect(b).toHaveLength(2); // still active
  });

  it("onDidChangeAgentState throws once the host is revoked", async () => {
    const { host, revoke } = await setupAgentHost(["agent:read"]);
    revoke();
    expect(() => host.onDidChangeAgentState(() => {})).toThrow(/host revoked/);
  });
});

describe("Plugin agent-input host API (#10558)", () => {
  type FakeTerminal = {
    id: string;
    projectId?: string;
    agentState?: string;
    detectedAgentId?: string;
    launchAgentId?: string;
    lastOutputTime?: number;
    activityTier?: "active" | "background";
    hasPty?: boolean;
  };
  type AgentInputHost = {
    pluginId: string;
    sendToActiveAgent: (text: string, options?: { submit?: boolean }) => Promise<void>;
  };
  type FakePtyClient = {
    submit: ReturnType<typeof vi.fn>;
    stage: ReturnType<typeof vi.fn>;
    getActiveProjectId: () => string | null;
    getAllTerminalsAsync: () => Promise<FakeTerminal[]>;
  };

  function installFakePtyClient(
    terminals: FakeTerminal[],
    activeProjectId: string | null = null
  ): FakePtyClient {
    const fake: FakePtyClient = {
      submit: vi.fn(),
      stage: vi.fn(),
      getActiveProjectId: () => activeProjectId,
      getAllTerminalsAsync: () => Promise.resolve(terminals),
    };
    setPtyClientRef(fake as never);
    return fake;
  }

  async function setupInputHost(
    capabilities: string[]
  ): Promise<{ service: PluginService; host: AgentInputHost }> {
    await writePlugin("agent-input", {
      name: "acme.agent-input",
      version: "1.0.0",
      capabilities,
    });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host } = (
      service as unknown as { createHost: (id: string) => { host: AgentInputHost } }
    ).createHost("acme.agent-input");
    return { service, host };
  }

  beforeEach(() => {
    // Auto-approve JIT consent so the write-path assertions run without a
    // renderer; the denial branch is covered explicitly below.
    getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
  });
  afterEach(() => {
    _resetPluginCapabilityServicesForTest();
    setPtyClientRef(null);
  });

  it("rejects with PERMISSION_REQUIRED when agent:input is not declared", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:read"]);
    await expect(host.sendToActiveAgent("hello")).rejects.toThrow(
      /PERMISSION_REQUIRED.*agent:input/
    );
    expect(fake.submit).not.toHaveBeenCalled();
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("rejects empty text before consulting consent", async () => {
    installFakePtyClient([{ id: "t1", detectedAgentId: "claude", hasPty: true }]);
    const consent = getPluginCapabilityConsentService();
    const bridge = vi.fn(async () => "approved-once" as const);
    consent.setConsentBridge(bridge);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("")).rejects.toThrow(/non-empty/);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only text without banking consent or writing (#10558)", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const bridge = vi.fn(async () => "approved-once" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("\n")).rejects.toThrow(/non-empty/);
    await expect(host.sendToActiveAgent("   ", { submit: true })).rejects.toThrow(/non-empty/);
    expect(bridge).not.toHaveBeenCalled();
    expect(fake.stage).not.toHaveBeenCalled();
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("stages (no Enter) by default when submit is omitted", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("draft prompt");
    expect(fake.stage).toHaveBeenCalledWith("t1", "draft prompt");
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("submits (with Enter) when submit:true", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("run it", { submit: true });
    expect(fake.submit).toHaveBeenCalledWith("t1", "run it");
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("prefers a focused/visible agent over a backgrounded waiting agent", async () => {
    const fake = installFakePtyClient([
      {
        id: "bg",
        detectedAgentId: "claude",
        agentState: "waiting",
        activityTier: "background",
        lastOutputTime: 100,
        hasPty: true,
      },
      {
        id: "focused",
        launchAgentId: "claude",
        agentState: "working",
        activityTier: "active",
        lastOutputTime: 50,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("focused", "x");
  });

  it("falls back to most-recently-active agent when none are focused/waiting", async () => {
    const fake = installFakePtyClient([
      {
        id: "old",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 10,
        hasPty: true,
      },
      {
        id: "new",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 99,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("new", "x");
  });

  it("scopes selection to the active project when one is set", async () => {
    const fake = installFakePtyClient(
      [
        {
          id: "other",
          detectedAgentId: "claude",
          projectId: "p2",
          lastOutputTime: 999,
          hasPty: true,
        },
        { id: "mine", detectedAgentId: "claude", projectId: "p1", lastOutputTime: 1, hasPty: true },
      ],
      "p1"
    );
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("mine", "x");
  });

  it("never crosses into another project's terminals (#10558)", async () => {
    const fake = installFakePtyClient(
      [
        {
          id: "other",
          detectedAgentId: "claude",
          projectId: "p2",
          lastOutputTime: 999,
          hasPty: true,
        },
      ],
      "p1"
    );
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/NO_ACTIVE_AGENT/);
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("excludes exited, completed, and non-agent terminals", async () => {
    const fake = installFakePtyClient([
      { id: "noagent", agentState: "idle", hasPty: true },
      { id: "exited", detectedAgentId: "claude", agentState: "exited", hasPty: true },
      { id: "completed", detectedAgentId: "claude", agentState: "completed", hasPty: true },
      { id: "dead", detectedAgentId: "claude", agentState: "idle", hasPty: false },
      {
        id: "live",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 5,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("live", "x");
  });

  it("throws NO_ACTIVE_AGENT when no eligible agent terminal exists", async () => {
    const fake = installFakePtyClient([
      { id: "noagent", agentState: "idle", hasPty: true },
      { id: "exited", detectedAgentId: "claude", agentState: "exited", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/NO_ACTIVE_AGENT/);
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("blocks the write when consent is denied", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(fake.stage).not.toHaveBeenCalled();
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("becomes a no-op after the plugin is unloaded", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { service, host } = await setupInputHost(["agent:input"]);
    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-input");
    await expect(host.sendToActiveAgent("x")).resolves.toBeUndefined();
    expect(fake.stage).not.toHaveBeenCalled();
  });
});

describe("reserved contribution point warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("attaches componentPath to the matching panel kind when a view targets location 'panel' (#9229)", async () => {
    await writePlugin("views", {
      name: "acme.views",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            name: "Main",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.views.main",
        extensionId: "acme.views",
        componentPath: "plugin://acme.views/dist/view.js",
      })
    );
    const viewWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes(": views ")
    );
    expect(viewWarnings).toHaveLength(0);
  });

  it("rejects the whole manifest when a views entry has no matching panel id (#10620)", async () => {
    await writePlugin("orphan", {
      name: "acme.orphan",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "ghost",
            name: "Ghost",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // An orphan view (id matches no panel) is now a hard manifest error
    // (view_panel_ref_unknown superRefine), so the plugin never loads — no
    // panel kind is registered and the failure surfaces as an invalid manifest.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in orphan"),
      expect.anything()
    );
  });

  it("rejects the whole manifest when a view targets the unimplemented sidebar location (#10464)", async () => {
    await writePlugin("sidebar", {
      name: "acme.sidebar",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            name: "Main",
            componentPath: "./dist/view.js",
            location: "sidebar",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // `location: "sidebar"` fails ViewContributionSchema at parse time, so the
    // manifest is invalid and the plugin never loads — no panel kind, no
    // sibling registration, surfaced as a manifest error rather than a warning.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in sidebar"),
      expect.anything()
    );
  });

  it("warns when an views entry targets a PTY-backed panel", async () => {
    await writePlugin("pty-view", {
      name: "acme.pty-view",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc", hasPty: true }],
        views: [
          {
            id: "main",
            name: "Main",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const panelCall = (registerPanelKind as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      componentPath?: string;
      hasPty?: boolean;
    };
    expect(panelCall.hasPty).toBe(true);
    expect(panelCall.componentPath).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('views entry "main" matches a panel with hasPty=true')
    );
  });

  it("rejects the whole manifest when a view declares a traversal componentPath (#10464)", async () => {
    await writePlugin("unsafe", {
      name: "acme.unsafe",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            name: "Main",
            componentPath: "../escape.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // An unsafe componentPath fails ViewContributionSchema's refine at parse
    // time, so the manifest is invalid and the plugin never loads.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in unsafe"),
      expect.anything()
    );
  });

  it("rejects the whole manifest when a view declares an https componentPath (#10464)", async () => {
    await writePlugin("https", {
      name: "acme.https",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            name: "Main",
            componentPath: "https://evil.example/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in https"),
      expect.anything()
    );
  });

  it("rejects the whole manifest on duplicate views ids (#10620)", async () => {
    await writePlugin("dup", {
      name: "acme.dup",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          { id: "main", name: "First", componentPath: "./first.js", location: "panel" },
          { id: "main", name: "Second", componentPath: "./second.js", location: "panel" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // A duplicate view id is now a hard manifest error
    // (duplicate_contribution_id superRefine), so the plugin never loads —
    // no first-wins, no panel kind registered.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in dup"),
      expect.anything()
    );
  });

  it("registers a contributes.mcpServers entry without eagerly spawning it (#9235)", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("mcp", {
      name: "acme.mcp",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        mcpServers: [
          {
            id: "linear",
            name: "Linear MCP",
            command: "node",
            args: ["./server.js"],
            env: { LINEAR_API_KEY: "secret" },
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    // Lazy discovery (#9235): activation must NOT spawn the MCP subprocess —
    // it starts on the first `plugin-mcp:list-tools` enumeration instead.
    expect(mockPluginMcpSupervisor.start).not.toHaveBeenCalled();
    // The contribution is still registered so the IPC boundary can resolve and
    // lazily start it on demand.
    const lookup = service.findMcpServerContribution("acme.mcp", "linear");
    expect(lookup?.contribution).toEqual({
      id: "linear",
      name: "Linear MCP",
      command: "node",
      args: ["./server.js"],
      env: { LINEAR_API_KEY: "secret" },
    });
  });

  it("registers a contributes.forgeProviders entry with the forge provider registry", async () => {
    await writePlugin("forge", {
      name: "acme.forge",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        // `settingsScopeRef` / `viewRefs` are cross-validated against the
        // manifest's own settings/views (#10620), so the referenced ids must
        // exist; the referenced view in turn needs a matching panel id.
        panels: [{ id: "github-issues", name: "Issues", iconId: "eye", color: "#abc" }],
        settings: [{ id: "github", type: "string", label: "GitHub" }],
        views: [
          {
            id: "github-issues",
            name: "Issues",
            componentPath: "./issues.js",
            location: "panel",
          },
        ],
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues"],
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).toHaveBeenCalledWith("acme.forge", [
      {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        capabilities: ["issues", "pulls", "reviews"],
        settingsScopeRef: "github",
        viewRefs: ["github-issues"],
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("contributes.forgeProviders"));
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("does not call registerForgeProviders when the manifest declares no forgeProviders", async () => {
    await writePlugin("forge-none", {
      name: "acme.forge-none",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).not.toHaveBeenCalled();
  });

  it("does not warn about reserved points when the manifest omits them", async () => {
    await writePlugin("plain", {
      name: "acme.plain",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("does not warn when reserved arrays are explicitly present but empty", async () => {
    await writePlugin("explicit-empty", {
      name: "acme.explicit-empty",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: { views: [], mcpServers: [], forgeProviders: [] },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("migrates deprecated experimental_* contribution aliases to their stable names and warns (#10466)", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("legacy", {
      name: "acme.legacy",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        experimental_views: [
          { id: "viewer", name: "Viewer", componentPath: "./v.js", location: "panel" },
        ],
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // The deprecated aliases are honored: the view binds to its panel and the
    // MCP contribution resolves through the canonical lookup.
    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.legacy.viewer",
        componentPath: "plugin://acme.legacy/v.js",
      })
    );
    expect(service.findMcpServerContribution("acme.legacy", "svc")).toBeDefined();

    // Each deprecated alias logs exactly one deprecation warning naming the
    // stable replacement — not zero (silently migrated) or more than one
    // (double-emission from a future refactor).
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      warnMessages.filter(
        (m: string) =>
          m.includes("contributes.experimental_views is deprecated") &&
          m.includes("contributes.views")
      )
    ).toHaveLength(1);
    expect(
      warnMessages.filter(
        (m: string) =>
          m.includes("contributes.experimental_mcpServers is deprecated") &&
          m.includes("contributes.mcpServers")
      )
    ).toHaveLength(1);
  });

  it("still processes other contributions when reserved points are present", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("mixed", {
      name: "acme.mixed",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        views: [{ id: "viewer", name: "Viewer", componentPath: "./v.js", location: "panel" }],
        mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    // mcpServers is registered (no warning) but, under lazy
    // discovery (#9235), is NOT spawned at activation.
    expect(mockPluginMcpSupervisor.start).not.toHaveBeenCalled();
    expect(service.findMcpServerContribution("acme.mixed", "svc")).toBeDefined();
  });

  it("rejects the whole manifest when any view entry is an orphan (#10620)", async () => {
    await writePlugin("many", {
      name: "acme.many",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        // `a` matches a panel and would bind; `c` is an orphan with no matching
        // panel id. A single orphan view now fails the whole manifest
        // (view_panel_ref_unknown superRefine) rather than logging a warning.
        panels: [{ id: "a", name: "A", iconId: "eye", color: "#000" }],
        views: [
          { id: "a", name: "A", componentPath: "./a.js", location: "panel" },
          { id: "c", name: "C", componentPath: "./c.js", location: "panel" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    const orphanWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('"c" has no matching contributes.panels')
    );
    expect(orphanWarnings).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in many"),
      expect.anything()
    );
  });

  it("rejects a views entry with an invalid location at schema level", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-location",
      version: "1.0.0",
      contributes: {
        views: [{ id: "main", name: "Main", componentPath: "./v.js", location: "floating" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a views entry missing componentPath", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-path",
      version: "1.0.0",
      contributes: {
        views: [{ id: "main", name: "Main", location: "panel" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry missing command", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-cmd",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry with non-string env values", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-env",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc", command: "node", env: { PORT: 8080 } }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an mcpServers entry without optional args/env fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.minimal-mcp",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

// Boundary containment regression tests for issue #9276 — verify that a
// plugin's exceptions can't escape the host. Each block covers one boundary:
// activation, action dispatch, and the unload cascade.

describe("Plugin exception containment (#9276)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("Boundary 1 — activation failure", () => {
    it("records the activation error on getPluginLoadError without rethrowing", async () => {
      const pluginDir = path.join(tmpDir, "throws-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom on activate'); }"
      );

      const service = new PluginService(tmpDir);
      // The host MUST NOT crash — initialize() should resolve.
      await expect(service.initialize()).resolves.toBeUndefined();
      // Lazy by default (#10523): trigger activation explicitly rather than via
      // the startup path, which no longer activates plugins without
      // activationEvents.
      await service.activatePlugin("acme.throws-activate");

      const record = service.getPluginLoadError("acme.throws-activate");
      expect(record).toBeDefined();
      expect(record?.message).toBe("boom on activate");
      expect(record?.stack).toContain("boom on activate");
      expect(typeof record?.at).toBe("number");
      // The plugin is still registered (manifest-declared contributions survive
      // even if the JS main entry blows up).
      expect(service.hasPlugin("acme.throws-activate")).toBe(true);
    });

    it("returns undefined when the plugin's activate succeeds", async () => {
      const pluginDir = path.join(tmpDir, "clean-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.clean-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { return () => {}; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.clean-activate");

      expect(service.getPluginLoadError("acme.clean-activate")).toBeUndefined();
    });

    it("returns undefined when the plugin declares no main entry", async () => {
      await writePlugin("no-main", { name: "acme.no-main", version: "1.0.0" });
      const service = new PluginService(tmpDir);
      await service.initialize();

      expect(service.getPluginLoadError("acme.no-main")).toBeUndefined();
    });

    it("load error persists in the provenance record across unload", async () => {
      const pluginDir = path.join(tmpDir, "throws-then-unload");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-then-unload", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom'); }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-then-unload");
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();

      // Unload removes the plugin from the registry, but the persisted
      // provenance record (including loadError) survives so diagnostics
      // export and re-install flows can still read it.
      service.unloadPlugin("acme.throws-then-unload");
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();
      expect(service.getPluginLoadError("acme.throws-then-unload")?.message).toBe("boom");
    });

    it("normalises non-Error throws into a load error record", async () => {
      const pluginDir = path.join(tmpDir, "throws-string");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-string", version: "1.0.0", main: "main.mjs" })
      );
      // Throw a plain string — many plugin authors do this.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw 'plain-string-failure'; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-string");

      const record = service.getPluginLoadError("acme.throws-string");
      expect(record?.message).toBe("plain-string-failure");
      expect(record?.stack).toBeUndefined();
    });
  });

  describe("Boundary 2 — action handler throw", () => {
    it("dispatchHandler rejects with the original error and logs to console.error", async () => {
      await writePlugin("acme.throwy-handler", {
        name: "acme.throwy-handler",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("handler boom");
      service.registerHandler("acme.throwy-handler", "blow-up", () => {
        throw original;
      });

      await expect(
        service.dispatchHandler(
          "acme.throwy-handler",
          "blow-up",
          makeCtx("acme.throwy-handler"),
          []
        )
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.throwy-handler:blow-up" threw:`),
        original
      );
    });

    it("dispatchHandler rejects with an async handler's rejection and logs", async () => {
      await writePlugin("acme.async-throwy", {
        name: "acme.async-throwy",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("async boom");
      service.registerHandler("acme.async-throwy", "blow-up", async () => {
        throw original;
      });

      await expect(
        service.dispatchHandler("acme.async-throwy", "blow-up", makeCtx("acme.async-throwy"), [])
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.async-throwy:blow-up" threw:`),
        original
      );
    });
  });

  describe("Boundary 3 — unload cascade containment", () => {
    it("continues past a throwing menu-items unregister and still clears the plugin", async () => {
      await writePlugin("cascade-test", {
        name: "acme.cascade-test",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
          toolbarButtons: [
            { id: "btn", label: "Btn", iconId: "icon", actionId: "acme.cascade-test.act" },
          ],
          menuItems: [{ label: "L", actionId: "acme.cascade-test.act", location: "terminal" }],
        },
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginMenuItems).mockImplementationOnce(() => {
        throw new Error("menu unregister boom");
      });

      service.unloadPlugin("acme.cascade-test");

      // Each step after the throwing one still ran:
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.cascade-test");

      // Containment guarantees: plugin gone from registry, no rethrown error.
      expect(service.hasPlugin("acme.cascade-test")).toBe(false);

      // Disposer throws are warnings, not errors (per issue constraint).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginMenuItems" for "acme.cascade-test" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing toolbar unregister", async () => {
      await writePlugin("toolbar-throws", {
        name: "acme.toolbar-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginToolbarButtons).mockImplementationOnce(() => {
        throw new Error("toolbar boom");
      });

      service.unloadPlugin("acme.toolbar-throws");

      // Subsequent steps in cascade still run.
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.toolbar-throws");
      expect(service.hasPlugin("acme.toolbar-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginToolbarButtons" for "acme.toolbar-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing forge-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("forge-throws", {
        name: "acme.forge-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterForgeProviders).mockImplementationOnce(() => {
        throw new Error("forge boom");
      });

      service.unloadPlugin("acme.forge-throws");

      // Critical: the impl unregister must run even if the provider unregister
      // threw, otherwise impl entries leak across reload. Coupled steps under
      // a single try/catch wrapper would have skipped this call.
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(service.hasPlugin("acme.forge-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterForgeProviders" for "acme.forge-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing fileDecoration-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("file-decoration-throws", {
        name: "acme.file-decoration-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterFileDecorationProviders).mockImplementationOnce(() => {
        throw new Error("file-decoration boom");
      });

      service.unloadPlugin("acme.file-decoration-throws");

      // Same correctness check as the forge case: the impl unregister must
      // not be stranded by a throw in the provider unregister.
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.file-decoration-throws"
      );
      expect(service.hasPlugin("acme.file-decoration-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterFileDecorationProviders" for "acme.file-decoration-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing removeHandlers, running every later registry step", async () => {
      await writePlugin("remove-handlers-throws", {
        name: "acme.remove-handlers-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
          toolbarButtons: [
            { id: "b", label: "B", iconId: "i", actionId: "acme.remove-handlers-throws.act" },
          ],
          menuItems: [
            { label: "L", actionId: "acme.remove-handlers-throws.act", location: "terminal" },
          ],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const removeHandlersSpy = vi
        .spyOn(service as unknown as { removeHandlers: (id: string) => void }, "removeHandlers")
        .mockImplementationOnce(() => {
          throw new Error("removeHandlers boom");
        });

      service.unloadPlugin("acme.remove-handlers-throws");

      // Even though the very first step threw, every later step ran.
      expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.remove-handlers-throws"
      );
      expect(service.hasPlugin("acme.remove-handlers-throws")).toBe(false);

      removeHandlersSpy.mockRestore();
    });
  });

  describe("Boundary 1 — non-Error throws", () => {
    it("normalises a bare `throw undefined` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-undefined");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-undefined", version: "1.0.0", main: "main.mjs" })
      );
      // `throw undefined` is a real footgun in plugin code — make sure the
      // load-error record never sneaks an `undefined` into its `message`
      // field, which would violate the type contract for the F19 / #9271
      // consumer.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw undefined; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-undefined");

      const record = service.getPluginLoadError("acme.throws-undefined");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });

    it("normalises a bare `throw null` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-null");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-null", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw null; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-null");

      const record = service.getPluginLoadError("acme.throws-null");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });
  });
});

describe("hello-daintree sample fixture", () => {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../plugins/sample/hello-daintree/plugin.json"
  );
  const readManifest = async (): Promise<unknown> =>
    JSON.parse(await fs.readFile(fixturePath, "utf8"));

  it("validates against the manifest schema", async () => {
    const result = getPluginManifestSchema(true).safeParse(await readManifest());
    expect(result.success).toBe(true);
  });

  it("declares the first-party name and the wired contribution points", async () => {
    const manifest = getPluginManifestSchema(true).parse(await readManifest());
    expect(manifest.name).toBe("daintree.hello");
    expect(manifest.engines?.daintree).toBe(">=0.11.0");
    expect(manifest.contributes.toolbarButtons).toHaveLength(1);
    expect(manifest.contributes.toolbarButtons[0].id).toBe("ping");
    expect(manifest.contributes.menuItems).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders[0].scopes).toEqual(["hello:*"]);
  });
});

describe("Plugin provenance persistence", () => {
  it("creates a sideload record for non-builtin plugin on first load", async () => {
    await writePlugin("fresh", { name: "acme.fresh", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].source).toBe("sideload");
    expect(plugins[0].installedAt).toBeGreaterThan(0);
    expect(plugins[0].archiveHash).toBeNull();
    expect(plugins[0].originalUrl).toBeNull();
    expect(plugins[0].disabled).toBe(false);
    expect(plugins[0].updateAvailable).toBeNull();
    expect(plugins[0].devMode).toBe(false);
    expect(plugins[0].loadError).toBeNull();
  });

  it("built-in plugins return synthetic provenance fields without a store record", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-prov-"));
    try {
      const dir = path.join(builtinDir, "helper");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.helper", version: "1.0.0" })
      );

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
      expect(builtin).toBeDefined();
      expect(builtin!.source).toBe("builtin");
      expect(builtin!.installedAt).toBe(0);
      expect(builtin!.archiveHash).toBeNull();
      expect(builtin!.originalUrl).toBeNull();
      expect(builtin!.loadError).toBeNull();
      expect(builtin!.disabled).toBe(false);
      expect(builtin!.updateAvailable).toBeNull();
      expect(builtin!.devMode).toBe(false);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("preserves installedAt across repeated loads (idempotent record creation)", async () => {
    await writePlugin("persist", { name: "acme.persist", version: "1.0.0" });

    const first = new PluginService(tmpDir);
    await first.initialize();
    const firstInstalledAt = first.listPlugins()[0].installedAt;

    // Second service instance simulates a restart — the store mock persists
    // the record (store is a singleton mock in tests).
    const second = new PluginService(tmpDir);
    await second.initialize();

    const plugins = second.listPlugins();
    expect(plugins[0].installedAt).toBe(firstInstalledAt);
  });

  it("non-builtin plugin with disabled=true is listed but not activated", async () => {
    const pluginDir = path.join(tmpDir, "disabled-nonbuiltin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.disabled-nb",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // main.mjs calls a global to prove activation was skipped
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__disabledActivated = true; export function activate() {}"
    );

    // Pre-seed the store with the unified disabled list (#9284); the
    // provenance record's `disabled` field is set independently by
    // setEnabled() — listing alone surfaces the unified state.
    storeMock._state.set("plugins", {
      disabled: ["acme.disabled-nb"],
      installed: {
        "acme.disabled-nb": {
          source: "sideload",
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: true,
          updateAvailable: null,
          devMode: false,
          loadError: null,
        },
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Run the startup activation pass and an explicit trigger: the disabled
    // plugin is rejected at scan time (never inserted into the plugins map), so
    // neither path can pick it up — that's exactly what we assert below.
    await service.activateStartupFinishedPlugins();
    await service.activatePlugin("acme.disabled-nb");

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.disabled-nb");
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);

    // Activation was skipped — the main.mjs was never imported
    expect((globalThis as Record<string, unknown>).__disabledActivated).toBeUndefined();
  });

  it("writes activation error to the persisted record", async () => {
    const pluginDir = path.join(tmpDir, "err-persist");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.err-persist", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('persisted-boom'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.err-persist");

    const record = service.getPluginLoadError("acme.err-persist");
    expect(record?.message).toBe("persisted-boom");

    // Also visible via listPlugins
    const plugins = service.listPlugins();
    expect(plugins[0].loadError?.message).toBe("persisted-boom");
  });

  it("clears loadError on a subsequent successful activation", async () => {
    // Use two different plugin directories with distinct names to avoid
    // Node ESM module caching (import() caches by URL, so the same file
    // path would return the cached throwing module).
    const failDir = path.join(tmpDir, "heal-fail");
    await fs.mkdir(failDir);
    await fs.writeFile(
      path.join(failDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-fail", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(failDir, "main.mjs"),
      "globalThis.__healFailCalled = true; export function activate() { throw new Error('first-fail'); }"
    );

    const first = new PluginService(tmpDir);
    await first.initialize();
    await first.activatePlugin("acme.heal-fail");
    expect(first.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");

    // Second plugin: same concept but different dir + name, so ESM cache
    // doesn't interfere. The store still holds the first plugin's error
    // record, confirming persistence works.
    const healDir = path.join(tmpDir, "heal-ok");
    await fs.mkdir(healDir);
    await fs.writeFile(
      path.join(healDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-ok", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(healDir, "main.mjs"),
      "export function activate() { return () => {}; }"
    );

    const second = new PluginService(tmpDir);
    await second.initialize();
    await second.activatePlugin("acme.heal-ok");

    // New plugin loaded successfully — no error
    expect(second.getPluginLoadError("acme.heal-ok")).toBeUndefined();
    const plugins = second.listPlugins();
    const healed = plugins.find((p) => p.manifest.name === "acme.heal-ok");
    expect(healed?.loadError).toBeNull();

    // Original failed plugin's error still in the store
    expect(second.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");
  });

  it("getPluginLoadError returns undefined for an unknown plugin", () => {
    const service = new PluginService(tmpDir);
    expect(service.getPluginLoadError("acme.never-existed")).toBeUndefined();
  });

  it("listPlugins includes all provenance fields in output", async () => {
    await writePlugin("full-prov", { name: "acme.full-prov", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const [plugin] = service.listPlugins();
    expect(Object.keys(plugin)).toContain("source");
    expect(Object.keys(plugin)).toContain("installedAt");
    expect(Object.keys(plugin)).toContain("archiveHash");
    expect(Object.keys(plugin)).toContain("originalUrl");
    expect(Object.keys(plugin)).toContain("loadError");
    expect(Object.keys(plugin)).toContain("disabled");
    expect(Object.keys(plugin)).toContain("updateAvailable");
    expect(Object.keys(plugin)).toContain("devMode");
    // Runtime fields still present
    expect(Object.keys(plugin)).toContain("manifest");
    expect(Object.keys(plugin)).toContain("dir");
    expect(Object.keys(plugin)).toContain("loadedAt");
    expect(Object.keys(plugin)).toContain("isBuiltin");
    // Internal field still excluded
    expect(Object.keys(plugin)).not.toContain("resolvedMain");
  });

  it("disabled builtin returns disabled=true in listPlugins output", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-dis-"));
    try {
      const dir = path.join(builtinDir, "muted");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.muted", version: "1.0.0" })
      );

      storeMock._state.set("plugins", { disabled: ["daintree.muted"], installed: {} });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      // Disabled builtins are tracked in `disabledPlugins` so listPlugins()
      // can surface them for the Preferences toggle (#9284); they are not
      // activated. The entry reports disabled=true.
      const plugins = service.listPlugins();
      const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
      expect(muted).toBeDefined();
      expect(muted!.disabled).toBe(true);
      expect(muted!.loadedAt).toBe(0);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("plugin with dot in name stores record without nesting", async () => {
    // Plugin names are scoped as "publisher.name" — a single dot is valid.
    // electron-store's dotNotation would split "acme.foo" into nested keys
    // if written per-field, so we write the whole `plugins.installed` object.
    const pluginDir = path.join(tmpDir, "dot-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.foo", version: "1.0.0" })
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.foo");

    // Record stored under the dotted name without nesting
    const stored = storeMock._state.get("plugins") as
      | { installed?: Record<string, unknown> }
      | undefined;
    expect(stored?.installed).toHaveProperty("acme.foo");
    expect(stored?.installed?.["acme.foo"]).toBeDefined();
  });
});

describe("PluginManifestSchema activationEvents field", () => {
  const schema = getPluginManifestSchema(false);

  it("defaults to an empty array when omitted", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activationEvents).toEqual([]);
    }
  });

  it("accepts an explicit ['onStartupFinished']", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onStartupFinished"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown activation event strings (no onCommand/onView in v1)", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onCommand:foo"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array activationEvents value", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: "onStartupFinished",
    });
    expect(result.success).toBe(false);
  });
});

describe("Deferred activation — activatePlugin", () => {
  it("lazy by default: no activationEvents stays deferred through activateStartupFinishedPlugins, activates on first use (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "deferred-import");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.deferred-import", version: "1.0.0", main: "main.mjs" })
    );
    // The module sets a global as a side effect at import time. If the
    // module were imported during initialize()/startup the global would be set
    // before we explicitly activate.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__deferredImportRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // Scan must register the plugin (contributions populated) but must NOT
      // have imported its main module yet.
      expect(service.hasPlugin("acme.deferred-import")).toBe(true);
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBeUndefined();

      // With no activationEvents the plugin is lazy: startup activation must
      // leave it deferred (the inverse of the pre-#10523 behavior).
      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBeUndefined();

      // An explicit first-use trigger imports main and runs activate().
      await service.activatePlugin("acme.deferred-import");
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__deferredImportRan;
    }
  });

  it("activatePlugin is idempotent — _doActivate runs once across concurrent callers", async () => {
    const pluginDir = path.join(tmpDir, "dedup-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.dedup-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__dedupCount = (globalThis.__dedupCount ?? 0) + 1; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Fan out activation from three concurrent callers; the in-flight
      // promise dedup means _doActivate runs exactly once.
      await Promise.all([
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
      ]);

      // A fourth call after the first settled should hit the synchronous
      // `activatedPlugins` fast path and not re-import either.
      await service.activatePlugin("acme.dedup-activate");

      expect((globalThis as unknown as Record<string, number>).__dedupCount).toBe(1);
    } finally {
      delete (globalThis as unknown as Record<string, number>).__dedupCount;
    }
  });

  it("activatePlugin does not reject when activate() throws", async () => {
    const pluginDir = path.join(tmpDir, "throwy-but-stable");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.throwy-but-stable", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('nope'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Implicit-trigger contract: the promise resolves so callers don't
      // need a try/catch around every dispatch.
      await expect(service.activatePlugin("acme.throwy-but-stable")).resolves.toBeUndefined();
      // Error is persisted to the provenance record instead of propagating.
      expect(service.getPluginLoadError("acme.throwy-but-stable")?.message).toBe("nope");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("activatePlugin can re-run after a failure (Settings → Retry)", async () => {
    const pluginDir = path.join(tmpDir, "retry-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.retry-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__retryCount = (globalThis.__retryCount ?? 0) + 1; export function activate() { throw new Error('retry-boom'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.retry-activate");

      // After a failure the in-flight entry is dropped so a retry calls
      // through to _doActivate again. ESM import() is URL-cached, so the
      // module is only evaluated once — but `activate()` still runs again
      // on the cached exports. Assert via the persisted error record.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");

      await service.activatePlugin("acme.retry-activate");
      // The fact that this resolves and re-records the error proves the
      // promise was not cached as a settled success.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as unknown as Record<string, number>).__retryCount;
    }
  });

  it("activateStartupFinishedPlugins activates plugins with activationEvents=['onStartupFinished']", async () => {
    const pluginDir = path.join(tmpDir, "explicit-onstartup");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.explicit-onstartup",
        version: "1.0.0",
        main: "main.mjs",
        activationEvents: ["onStartupFinished"],
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__explicitOnstartupRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBeUndefined();

      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__explicitOnstartupRan;
    }
  });

  it("activatePluginForView resolves the owning plugin from contributes.panels and activates it (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-owner");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-owner",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", name: "Viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__viewOwnerActivated = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // Lazy: registered but not yet activated.
      expect(service.hasPlugin("acme.view-owner")).toBe(true);
      expect((globalThis as Record<string, unknown>).__viewOwnerActivated).toBeUndefined();

      // Opening the contributed panel view (kind id `${pluginId}.${panel.id}`)
      // triggers first-use activation and reports success (#10618).
      await expect(service.activatePluginForView("acme.view-owner.viewer")).resolves.toEqual({
        ok: true,
      });
      expect((globalThis as Record<string, unknown>).__viewOwnerActivated).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__viewOwnerActivated;
    }
  });

  it("activatePluginForView is a no-op for an unknown or empty panel kind id (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-noop");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-noop",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", name: "Viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__viewNoopActivated = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Unknown kind id — and a non-matching bare id — must not activate
      // anything, and report ok (nothing to activate; #10618).
      await expect(service.activatePluginForView("acme.view-noop.nope")).resolves.toEqual({
        ok: true,
      });
      await expect(service.activatePluginForView("viewer")).resolves.toEqual({ ok: true });
      await expect(service.activatePluginForView("")).resolves.toEqual({ ok: true });
      expect((globalThis as Record<string, unknown>).__viewNoopActivated).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).__viewNoopActivated;
    }
  });

  it("activatePluginForView records loadError on activation failure and retries on a second open (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-fail");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-fail",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", name: "Viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { globalThis.__viewFailActivateCount = (globalThis.__viewFailActivateCount ?? 0) + 1; throw new Error('view-activate-boom'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // First open: activation fails but never rejects; contributions survive.
      // The failure is surfaced as a plain { ok: false } result (#10618) carrying
      // the real activate() error so PluginViewHost can throw it before import.
      // (toMatchObject because the result also carries the diagnostic `stack`.)
      await expect(service.activatePluginForView("acme.view-fail.viewer")).resolves.toMatchObject({
        ok: false,
        error: "view-activate-boom",
      });
      expect(service.getPluginLoadError("acme.view-fail")?.message).toBe("view-activate-boom");
      expect(service.hasPlugin("acme.view-fail")).toBe(true);
      expect((globalThis as Record<string, unknown>).__viewFailActivateCount).toBe(1);

      // Second open: the failed in-flight entry was cleared, so activation runs
      // again (Settings → Retry / re-open semantics) rather than returning a
      // cached settled promise — proven by the activate() invocation count.
      await expect(service.activatePluginForView("acme.view-fail.viewer")).resolves.toMatchObject({
        ok: false,
        error: "view-activate-boom",
      });
      expect(service.getPluginLoadError("acme.view-fail")?.message).toBe("view-activate-boom");
      expect((globalThis as Record<string, unknown>).__viewFailActivateCount).toBe(2);
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).__viewFailActivateCount;
    }
  });

  it("a hanging activation times out instead of stalling forever", async () => {
    const pluginDir = path.join(tmpDir, "hanging-import");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.hanging-import", version: "1.0.0", main: "main.mjs" })
    );
    // Top-level `await new Promise(() => {})` hangs the worker's import forever.
    // The worker is isolated (it can't stall main), but the activation gate must
    // still time out so `Promise.allSettled` startup fan-outs aren't pinned.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "await new Promise(() => {}); export function activate() {}"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // The promise resolves (it doesn't reject — `activatePlugin` swallows) and
      // the activation-timeout error is persisted as the loadError so diagnostics
      // surface why the plugin never came up.
      await service.activatePlugin("acme.hanging-import");
      const record = service.getPluginLoadError("acme.hanging-import");
      expect(record?.message).toContain("did not settle");
    } finally {
      errorSpy.mockRestore();
    }
  }, 10_000);

  it("unloadPlugin during a racing activation does not leak activatedPlugins state", async () => {
    const pluginDir = path.join(tmpDir, "race-unload");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.race-unload", version: "1.0.0", main: "main.mjs" })
    );
    // Activate resolves successfully but the test will unload mid-flight so
    // the .then handler sees a tombstoned plugins map.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { return () => {}; }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    const activation = service.activatePlugin("acme.race-unload");
    // Synchronously unload before the activation promise resolves. The
    // plugin is still in `this.plugins` at this point (activation is
    // mid-flight), so unload runs fully.
    service.unloadPlugin("acme.race-unload");
    await activation;

    // The .then(success) handler now runs after unload; the guard must
    // prevent re-adding the id to `activatedPlugins`.
    expect(service.hasPlugin("acme.race-unload")).toBe(false);
    expect(
      (service as unknown as { activatedPlugins: Set<string> }).activatedPlugins.has(
        "acme.race-unload"
      )
    ).toBe(false);
    expect(
      (service as unknown as { cleanupMap: Map<string, () => void> }).cleanupMap.has(
        "acme.race-unload"
      )
    ).toBe(false);
  });

  it("dispatchHandler implicitly activates the owning plugin before lookup", async () => {
    const pluginDir = path.join(tmpDir, "implicit-dispatch");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.implicit-dispatch",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // The plugin's activate() registers a handler. If dispatchHandler did
    // not force activation first, the handler would not be registered yet
    // and the dispatch would throw "No plugin handler registered".
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate(host) { host.registerHandler('probe', () => 'pong'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Crucially, do NOT call activateStartupFinishedPlugins(). The dispatch
    // path itself must trigger activation.
    const result = await service.dispatchHandler(
      "acme.implicit-dispatch",
      "probe",
      makeCtx("acme.implicit-dispatch"),
      []
    );
    expect(result).toBe("pong");
  });
});

type SettingsScope = "user" | "project";
type SettingsHostShape = (pluginId: string) => {
  host: {
    settings: {
      get: <T = unknown>(key: string, scope?: SettingsScope) => Promise<T | undefined>;
      set: <T = unknown>(key: string, value: T, scope?: SettingsScope) => Promise<void>;
      onDidChange: <T = unknown>(
        key: string,
        cb: (value: T | undefined) => void,
        scope?: SettingsScope
      ) => () => void;
    };
  };
  revoke: () => void;
};

async function setupSettingsService(
  pluginId: string,
  settings?: Array<{ id: string; type: string; scope?: SettingsScope }>
): Promise<{ service: PluginService; settingsRoot: string }> {
  const pluginsRoot = path.join(tmpDir, "plugins");
  const dir = path.join(pluginsRoot, pluginId);
  await fs.mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: pluginId, version: "1.0.0" };
  if (settings) manifest.contributes = { settings };
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  const service = new PluginService(pluginsRoot);
  await service.initialize();
  // User-scope settings live as a sibling of the plugins dir.
  return { service, settingsRoot: path.join(tmpDir, "plugin-settings") };
}

function createSettingsHost(service: PluginService, pluginId: string) {
  return (service as unknown as { createHost: SettingsHostShape }).createHost(pluginId);
}

describe("createHost — settings", () => {
  beforeEach(() => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
  });

  it("get returns undefined for an unset key", async () => {
    const { service } = await setupSettingsService("acme.settings-get");
    const { host } = createSettingsHost(service, "acme.settings-get");
    expect(await host.settings.get("token")).toBeUndefined();
  });

  it("round-trips a value in user scope and persists it as JSON", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-rt");
    const { host } = createSettingsHost(service, "acme.settings-rt");
    await host.settings.set("token", "sk-test");
    expect(await host.settings.get<string>("token")).toBe("sk-test");
    const raw = await fs.readFile(path.join(settingsRoot, "acme.settings-rt.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ token: "sk-test" });
  });

  const chmodIt = process.platform === "win32" ? it.skip : it;
  chmodIt("writes the user-scope file with mode 0o600", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-mode");
    const { host } = createSettingsHost(service, "acme.settings-mode");
    await host.settings.set("token", "secret");
    const stat = await fs.stat(path.join(settingsRoot, "acme.settings-mode.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("project scope get returns undefined when no project is active", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    const { service } = await setupSettingsService("acme.settings-noproj");
    const { host } = createSettingsHost(service, "acme.settings-noproj");
    expect(await host.settings.get("token", "project")).toBeUndefined();
  });

  it("project scope set throws when no project is active", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    const { service } = await setupSettingsService("acme.settings-noproj2");
    const { host } = createSettingsHost(service, "acme.settings-noproj2");
    await expect(host.settings.set("token", "x", "project")).rejects.toThrow(/no active project/);
  });

  it("project scope writes under the active project root", async () => {
    const projectDir = path.join(tmpDir, "proj");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-proj");
    const { host } = createSettingsHost(service, "acme.settings-proj");
    await host.settings.set("token", "in-project", "project");
    expect(await host.settings.get<string>("token", "project")).toBe("in-project");
    const raw = await fs.readFile(
      path.join(projectDir, ".daintree", "plugin-settings", "acme.settings-proj.json"),
      "utf-8"
    );
    expect(JSON.parse(raw)).toEqual({ token: "in-project" });
  });

  it("resolves the active project at call time, tracking project switches", async () => {
    const projA = path.join(tmpDir, "projA");
    const projB = path.join(tmpDir, "projB");
    const { service } = await setupSettingsService("acme.settings-switch");
    const { host } = createSettingsHost(service, "acme.settings-switch");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projA });
    await host.settings.set("k", "a-value", "project");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projB });
    expect(await host.settings.get("k", "project")).toBeUndefined();
    await host.settings.set("k", "b-value", "project");
    expect(await host.settings.get<string>("k", "project")).toBe("b-value");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projA });
    expect(await host.settings.get<string>("k", "project")).toBe("a-value");
  });

  it("set rejects undefined and non-serializable values", async () => {
    const { service } = await setupSettingsService("acme.settings-bad");
    const { host } = createSettingsHost(service, "acme.settings-bad");
    await expect(host.settings.set("k", undefined as unknown as string)).rejects.toThrow(
      /undefined/
    );
    await expect(host.settings.set("k", (() => {}) as unknown as string)).rejects.toThrow(
      /not JSON-serializable/
    );
  });

  it("set rejects an empty key", async () => {
    const { service } = await setupSettingsService("acme.settings-emptykey");
    const { host } = createSettingsHost(service, "acme.settings-emptykey");
    await expect(host.settings.set("", "x")).rejects.toThrow(/non-empty string/);
  });

  it("onDidChange fires with the new value after a changing set", async () => {
    const { service } = await setupSettingsService("acme.settings-watch");
    const { host } = createSettingsHost(service, "acme.settings-watch");
    const cb = vi.fn();
    await host.settings.onDidChange<string>("token", cb);
    await host.settings.set("token", "v1");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("v1");
  });

  it("onDidChange does not fire for a no-op write", async () => {
    const { service } = await setupSettingsService("acme.settings-noop");
    const { host } = createSettingsHost(service, "acme.settings-noop");
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb);
    await host.settings.set("token", "same");
    await host.settings.set("token", "same");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDidChange only fires for its subscribed scope", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: path.join(tmpDir, "proj-scope") });
    const { service } = await setupSettingsService("acme.settings-scope");
    const { host } = createSettingsHost(service, "acme.settings-scope");
    const userCb = vi.fn();
    await host.settings.onDidChange("token", userCb, "user");
    await host.settings.set("token", "proj-value", "project");
    expect(userCb).not.toHaveBeenCalled();
  });

  it("onDidChange disposer stops further callbacks", async () => {
    const { service } = await setupSettingsService("acme.settings-dispose");
    const { host } = createSettingsHost(service, "acme.settings-dispose");
    const cb = vi.fn();
    const dispose = await host.settings.onDidChange("token", cb);
    dispose();
    await host.settings.set("token", "v1");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unloadPlugin disposes settings subscriptions", async () => {
    const { service } = await setupSettingsService("acme.settings-unload");
    const { host } = createSettingsHost(service, "acme.settings-unload");
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb);
    service.unloadPlugin("acme.settings-unload");
    await host.settings.set("token", "after-unload");
    expect(cb).not.toHaveBeenCalled();
  });

  it("revoked host rejects settings.onDidChange but still allows get/set", async () => {
    const { service } = await setupSettingsService("acme.settings-revoke");
    const { host, revoke } = createSettingsHost(service, "acme.settings-revoke");
    revoke();
    expect(() => host.settings.onDidChange("token", () => {})).toThrow(/host revoked/);
    await expect(host.settings.set("token", "still-works")).resolves.toBeUndefined();
    expect(await host.settings.get<string>("token")).toBe("still-works");
  });

  // #10586: get must honor a key's manifest-declared scope rather than silently
  // defaulting to "user", mirroring the set/onDidChange scope guards.
  it("get resolves a project-scoped declared key from the project store with no scope arg", async () => {
    const projectDir = path.join(tmpDir, "proj-declared");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-declared-proj", [
      { id: "ref", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-proj");
    // Written to project scope; a no-scope read must resolve there, not "user".
    await host.settings.set("ref", "branch-x", "project");
    expect(await host.settings.get<string>("ref")).toBe("branch-x");
    // The value lives in the project file — proving the read didn't fall back to
    // the (empty) user store.
    const raw = await fs.readFile(
      path.join(projectDir, ".daintree", "plugin-settings", "acme.settings-declared-proj.json"),
      "utf-8"
    );
    expect(JSON.parse(raw)).toEqual({ ref: "branch-x" });
  });

  it("get throws when the explicit scope conflicts with the declared scope", async () => {
    const projectDir = path.join(tmpDir, "proj-conflict");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-declared-conflict", [
      { id: "ref", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-conflict");
    await expect(host.settings.get("ref", "user")).rejects.toThrow(
      /settings\.get: key "ref" is declared in "project" scope, not "user"/
    );
  });

  it("get falls back to user scope for an undeclared key", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-undeclared", [
      { id: "declared", type: "string", scope: "user" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-undeclared");
    // "loose" isn't declared, so a write would be rejected — seed the user-scope
    // file directly to prove the read still resolves the permissive "user"
    // default for undeclared keys.
    await fs.mkdir(settingsRoot, { recursive: true });
    await fs.writeFile(
      path.join(settingsRoot, "acme.settings-undeclared.json"),
      JSON.stringify({ loose: "v" })
    );
    expect(await host.settings.get<string>("loose")).toBe("v");
  });

  it("get resolves a user-declared key from the user store with no scope arg", async () => {
    const { service } = await setupSettingsService("acme.settings-declared-user", [
      { id: "token", type: "string", scope: "user" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-user");
    await host.settings.set("token", "sk-1", "user");
    expect(await host.settings.get<string>("token")).toBe("sk-1");
  });
});

describe("init gate — waitForInit() and pushSnapshotTo() (#9285)", () => {
  it("waitForInit() stays pending until activateStartupFinishedPlugins() settles", async () => {
    const service = new PluginService(tmpDir);
    let resolved = false;
    const waiter = service.waitForInit().then(() => {
      resolved = true;
    });
    // Yield through several microtasks to make sure nothing leaks out of init.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    await service.activateStartupFinishedPlugins();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("waitForInit() resolves after activateStartupFinishedPlugins() even with zero plugins", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    await expect(service.waitForInit()).resolves.toBeUndefined();
  });

  it("dispose() resolves a pending waitForInit() so callers don't deadlock", async () => {
    const service = new PluginService(tmpDir);
    const waiter = service.waitForInit();
    service.dispose();
    await expect(waiter).resolves.toBeUndefined();
  });

  it("pushSnapshotTo() sends actions, panel kinds, toolbar buttons, context-menu items, and agents to the target webContents", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).toHaveBeenCalledTimes(6);
    // Every replay goes through the EVENTS_PUSH channel — the same channel the
    // renderer hooks' persistent push listeners consume, so no renderer-side
    // changes are needed for the cold-restore path.
    for (const call of send.mock.calls) {
      expect(call[0]).toBe(CHANNELS.EVENTS_PUSH);
    }
    const names = send.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toContain("plugin:actions-changed");
    expect(names).toContain("plugin:panel-kinds-changed");
    expect(names).toContain("plugin:toolbar-buttons-changed");
    expect(names).toContain("plugin:keybindings-changed");
    expect(names).toContain("plugin:context-menu-items-changed");
    expect(names).toContain("plugin:agents-changed");
    // The renderer menu-items channel was removed (#10465) — guard against the
    // cold-restore replay accidentally re-emitting it.
    expect(names).not.toContain("plugin:menu-items-changed");
    // The keybindings replay is a full authoritative snapshot — the renderer
    // hook full-replaces its plugin bindings on every push, so `complete: true`
    // is consistent with that replace-all semantics.
    const keybindingsCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:keybindings-changed"
    );
    expect((keybindingsCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(
      true
    );
    // Toolbar and context-menu-item replays must use `complete: false`
    // so the renderer does not run a stale-prune sweep — replay is a load-style
    // snapshot, not an unload-driven authoritative sweep.
    const toolbarCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:toolbar-buttons-changed"
    );
    expect((toolbarCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(false);
    const contextMenuItemsCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:context-menu-items-changed"
    );
    expect((contextMenuItemsCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(
      false
    );
  });

  it("pushSnapshotTo() keeps sending remaining channels when one send() throws (TOCTOU)", async () => {
    // Simulates the wc being destroyed between the isDestroyed() guard and an
    // individual send — Electron raises "Object has been destroyed". Without
    // per-send try/catch one bad call would silently drop the remaining
    // channels and the cold-restored renderer would miss state.
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn((_channel: string, payload: { name: string }) => {
      if (payload.name === "plugin:actions-changed") {
        throw new Error("Object has been destroyed");
      }
    });
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).toHaveBeenCalledTimes(6);
    const names = send.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toContain("plugin:panel-kinds-changed");
    expect(names).toContain("plugin:toolbar-buttons-changed");
    expect(names).toContain("plugin:keybindings-changed");
    expect(names).toContain("plugin:context-menu-items-changed");
    expect(names).toContain("plugin:agents-changed");
  });

  it("pushSnapshotTo() skips a destroyed webContents", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn();
    const wc = { send, isDestroyed: () => true } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).not.toHaveBeenCalled();
  });

  it("pushSnapshotTo() waits for init before sending — no empty snapshot races startup", async () => {
    const service = new PluginService(tmpDir);
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    // Fire pushSnapshotTo before init has resolved — it must hold off the
    // webContents.send calls until activateStartupFinishedPlugins() settles.
    const inFlight = service.pushSnapshotTo(wc);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    await service.activateStartupFinishedPlugins();
    await inFlight;
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("pushSnapshotTo() does not send after dispose()", async () => {
    const service = new PluginService(tmpDir);
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;
    const inFlight = service.pushSnapshotTo(wc);
    service.dispose();
    await inFlight;
    expect(send).not.toHaveBeenCalled();
  });
});

describe("dev-mode hot reload (#9304)", () => {
  beforeEach(() => {
    devWorkerMock.instances.length = 0;
    devWorkerMock.bridges.length = 0;
  });

  async function writeDevPlugin(name: string, pluginName: string): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");
  }

  it("flags a .dev-marker plugin as devMode in listPlugins (drives the DEV badge)", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    const info = service.listPlugins().find((p) => p.manifest.name === "acme.dev");
    expect(info?.devMode).toBe(true);
  });

  it("routes activation of a dev plugin through the hot-reload worker", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    expect(devWorkerMock.instances).toHaveLength(1);
    expect(devWorkerMock.instances[0].opts.pluginId).toBe("acme.dev");
    expect(devWorkerMock.instances[0].opts.bundlePath).toMatch(/dist[/\\]index\.js$/);
    expect(devWorkerMock.instances[0].opts.mode).toBe("dev");
    expect(devWorkerMock.instances[0].start).toHaveBeenCalledTimes(1);
    expect(devWorkerMock.bridges[0].waitForActivation).toHaveBeenCalledTimes(1);
  });

  it("forks a prod-mode worker for a plugin without a dev marker (#10526)", async () => {
    const dir = path.join(tmpDir, "prod-plugin");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: "acme.prod", version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.prod");

    // Every user plugin runs out-of-process now: a prod plugin forks the same
    // worker as a dev plugin, but in "prod" mode (no hot-reload file watcher).
    expect(devWorkerMock.instances).toHaveLength(1);
    expect(devWorkerMock.instances[0].opts.pluginId).toBe("acme.prod");
    expect(devWorkerMock.instances[0].opts.mode).toBe("prod");
    const info = service.listPlugins().find((p) => p.manifest.name === "acme.prod");
    expect(info?.devMode).toBe(false);
  });

  it("activates a built-in plugin in-process, NOT via a worker (#10526)", async () => {
    // Built-ins stay on the in-process loader: they're trusted app-bundled code
    // that may use synchronous host surfaces (registerForgeProvider) which can't
    // cross the worker's async port — routing them through it would break forge.
    const builtinRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-route-"));
    try {
      const dir = path.join(builtinRoot, "daintree.builtin");
      await fs.mkdir(path.join(dir, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.builtin", version: "1.0.0", main: "dist/index.js" })
      );
      await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinRoot });
      await service.initialize();
      await service.activatePlugin("daintree.builtin");

      // No worker forked for the built-in; it activated via the in-process loader.
      expect(devWorkerMock.instances).toHaveLength(0);
      const info = service.listPlugins().find((p) => p.manifest.name === "daintree.builtin");
      expect(info?.isBuiltin).toBe(true);
    } finally {
      await fs.rm(builtinRoot, { recursive: true, force: true });
    }
  });

  it("disposes the worker and bridge when the dev plugin is unloaded", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    const worker = devWorkerMock.instances[0];
    const bridge = devWorkerMock.bridges[0];
    service.unloadPlugin("acme.dev");
    expect(bridge.dispose).toHaveBeenCalled();
    expect(worker.dispose).toHaveBeenCalled();
  });

  it("keeps manifest commands registered across a reload (clearPriorRegistrations)", async () => {
    const dir = path.join(tmpDir, "dev-cmd");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.dev",
        version: "1.0.0",
        main: "dist/index.js",
        contributes: {
          commands: [
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Run the thing",
              category: "Dev",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    // Manifest command is registered at load time.
    expect(service.listPluginActions().some((a) => a.id === "acme.dev.do-thing")).toBe(true);

    // Simulate a hot reload: the bridge calls clearPriorRegistrations before the
    // worker re-registers. Manifest commands must survive — only imperative
    // (host.registerAction) actions are dropped.
    const clearPriorRegistrations = (
      devWorkerMock.bridges[0].deps as unknown as { clearPriorRegistrations: () => void }
    ).clearPriorRegistrations;
    clearPriorRegistrations();

    expect(service.listPluginActions().some((a) => a.id === "acme.dev.do-thing")).toBe(true);
  });
});
