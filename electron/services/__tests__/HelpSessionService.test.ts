import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { McpRuntimeSnapshot } from "../../../shared/types/ipc/mcpServer.js";

const { mockUserDataDir, mockHelpFolderPath, mockMcpServerService, mockStoreGet } = vi.hoisted(
  () => ({
    mockUserDataDir: vi.fn<() => string>(),
    mockHelpFolderPath: vi.fn<() => string | null>(),
    mockMcpServerService: {
      isRunning: true,
      currentPort: 45454 as number | null,
      enabled: true,
      isEnabled() {
        return this.enabled;
      },
      start: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setHelpTokenValidator: vi.fn(),
      getRuntimeState: vi.fn<
        () => import("../../../shared/types/ipc/mcpServer.js").McpRuntimeSnapshot
      >(() => ({
        enabled: true,
        state: "ready",
        port: 45454,
        lastError: null,
      })),
    },
    mockStoreGet: vi.fn<(key: string) => unknown>(),
  })
);

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key === "userData") return mockUserDataDir();
      throw new Error(`unexpected app.getPath: ${key}`);
    },
  },
}));

vi.mock("../HelpService.js", () => ({
  getHelpFolderPath: () => mockHelpFolderPath(),
}));

vi.mock("../McpServerService.js", () => ({
  mcpServerService: mockMcpServerService,
}));

vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) => mockStoreGet(key),
  },
}));

import { HelpSessionService } from "../HelpSessionService.js";

async function makeBundledHelpFolder(root: string): Promise<string> {
  const helpDir = path.join(root, "help");
  await fs.mkdir(path.join(helpDir, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(helpDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "daintree-docs": { type: "http", url: "https://daintree.org/api/mcp" } },
    })
  );
  await fs.writeFile(
    path.join(helpDir, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Read(**)", "WebFetch", "mcp__daintree-docs__*", "Bash(gh issue list*)"],
        deny: ["Write(**)", "Edit(**)", "Bash(**)"],
      },
    })
  );
  await fs.writeFile(path.join(helpDir, "CLAUDE.md"), "# Help");
  return helpDir;
}

describe("HelpSessionService", () => {
  let tmpRoot: string;
  let userData: string;
  let helpFolder: string;
  let service: HelpSessionService;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "help-session-svc-"));
    userData = path.join(tmpRoot, "userData");
    await fs.mkdir(userData, { recursive: true });
    helpFolder = await makeBundledHelpFolder(tmpRoot);

    mockUserDataDir.mockReturnValue(userData);
    mockHelpFolderPath.mockReturnValue(helpFolder);
    mockStoreGet.mockReset();
    mockStoreGet.mockReturnValue(undefined);
    mockMcpServerService.isRunning = true;
    mockMcpServerService.currentPort = 45454;
    mockMcpServerService.enabled = true;
    mockMcpServerService.start.mockClear();
    mockMcpServerService.setEnabled.mockClear();
    mockMcpServerService.setHelpTokenValidator.mockClear();

    service = new HelpSessionService();
    // The new `ensureMcpServerReady` path throws if no registry is wired —
    // every existing test predates the throw and assumes the wire-up
    // happened during app boot. Set it here so the tests exercise the
    // happy path; one test below intentionally tests the registry-set flow
    // by overriding to a different fakeRegistry.
    service.setMcpRegistry({} as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function provisionInput() {
    return {
      projectId: "proj-1",
      projectPath: "/tmp/project",
      windowId: 7,
      projectViewWebContentsId: 42,
    };
  }

  it("returns mcpUrl and windowId on the provision result when MCP is enabled", async () => {
    const result = await service.provisionSession(provisionInput());
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected result");

    expect(result.mcpUrl).toBe("http://127.0.0.1:45454/sse");
    expect(result.windowId).toBe(7);
  });

  it("returns mcpUrl=null when daintreeControl is false", async () => {
    mockStoreGet.mockReturnValue({ daintreeControl: false });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    expect(result.mcpUrl).toBeNull();
    expect(result.windowId).toBe(7);
  });

  it("creates a session dir with a .mcp.json that bakes the literal session token into the Authorization header", async () => {
    // Claude Code's `${VAR}` substitution in `headers` is broken (sends the
    // literal placeholder, gets 401) — must bake the literal token. Same
    // reason as McpPaneConfigService.ts.
    const result = await service.provisionSession(provisionInput());
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected result");

    const mcpRaw = await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8");
    const mcp = JSON.parse(mcpRaw);
    expect(mcp.mcpServers.daintree).toEqual({
      type: "sse",
      url: "http://127.0.0.1:45454/sse",
      headers: { Authorization: `Bearer ${result.token}` },
    });
    expect(mcp.mcpServers.daintree.headers.Authorization).not.toContain("${");
    expect(mcp.mcpServers["daintree-docs"]).toBeDefined();
  });

  it("sets enableAllProjectMcpServers in .claude/settings.json so Claude auto-trusts the bundled servers", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  it("appends mcp__daintree__* to the bundled allowlist when daintreeControl is enabled", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    const settingsRaw = await fs.readFile(
      path.join(result.sessionPath, ".claude", "settings.json"),
      "utf-8"
    );
    const settings = JSON.parse(settingsRaw);
    expect(settings.permissions.allow).toContain("mcp__daintree__*");
    expect(settings.permissions.allow).toContain("mcp__daintree-docs__*");
    expect(settings.permissions.deny).toContain("Write(**)");
  });

  it("sets defaultMode=bypassPermissions and tier=system when skipPermissions is true", async () => {
    mockStoreGet.mockReturnValue({ skipPermissions: true });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    expect(result.tier).toBe("system");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.defaultMode).toBe("bypassPermissions");
  });

  it("omits the daintree MCP server when daintreeControl is false", async () => {
    mockStoreGet.mockReturnValue({ daintreeControl: false });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    const mcp = JSON.parse(await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.daintree).toBeUndefined();
    expect(mcp.mcpServers["daintree-docs"]).toBeDefined();

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.permissions.allow).not.toContain("mcp__daintree__*");
  });

  it("validates a freshly minted token and rejects unknown / revoked tokens", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    expect(service.validateToken(result.token)).toBe("action");
    expect(service.validateToken("not-a-real-token")).toBe(false);

    await service.revokeSession(result.sessionId);
    expect(service.validateToken(result.token)).toBe(false);
  });

  it("preserves the per-project session dir on revoke so Claude's workspace-trust acceptance carries across launches", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    await fs.access(result.sessionPath);
    await service.revokeSession(result.sessionId);

    // Bearer is invalidated in-memory, but the dir stays — next launch
    // overwrites the .mcp.json with a fresh token rather than triggering a
    // new "Do you trust this folder?" prompt for the same project.
    expect(service.validateToken(result.token)).toBe(false);
    await fs.access(result.sessionPath);
  });

  it("strips the daintree entry from .mcp.json on revoke so a stray claude in that cwd can't auth with the dead token", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    const target = path.join(result.sessionPath, ".mcp.json");
    const before = JSON.parse(await fs.readFile(target, "utf-8"));
    expect(before.mcpServers.daintree).toBeDefined();
    expect(before.mcpServers["daintree-docs"]).toBeDefined();

    await service.revokeSession(result.sessionId);

    const after = JSON.parse(await fs.readFile(target, "utf-8"));
    expect(after.mcpServers.daintree).toBeUndefined();
    // daintree-docs entry must remain — it doesn't depend on a live session.
    expect(after.mcpServers["daintree-docs"]).toBeDefined();
  });

  it("reuses the same per-project session dir across consecutive launches with a freshly rotated bearer", async () => {
    const first = await service.provisionSession(provisionInput());
    if (!first) throw new Error("expected first provision");
    await service.revokeSession(first.sessionId);

    const second = await service.provisionSession(provisionInput());
    if (!second) throw new Error("expected second provision");

    expect(second.sessionPath).toBe(first.sessionPath);
    expect(second.token).not.toBe(first.token);

    const mcp = JSON.parse(await fs.readFile(path.join(second.sessionPath, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${second.token}`);
    expect(service.validateToken(first.token)).toBe(false);
    expect(service.validateToken(second.token)).toBe("action");
  });

  it("derives different session dirs for different project paths", async () => {
    const a = await service.provisionSession({ ...provisionInput(), projectPath: "/tmp/proj-a" });
    const b = await service.provisionSession({ ...provisionInput(), projectPath: "/tmp/proj-b" });
    if (!a || !b) throw new Error("expected provisions");
    expect(a.sessionPath).not.toBe(b.sessionPath);
  });

  it("revokeByWebContentsId removes only sessions bound to the matching webContents", async () => {
    const a = await service.provisionSession({ ...provisionInput(), projectViewWebContentsId: 1 });
    const b = await service.provisionSession({ ...provisionInput(), projectViewWebContentsId: 2 });
    if (!a || !b) throw new Error("expected provisions");

    await service.revokeByWebContentsId(1);
    expect(service.validateToken(a.token)).toBe(false);
    expect(service.validateToken(b.token)).toBe("action");
  });

  it("revokeAll wipes every active session", async () => {
    const a = await service.provisionSession(provisionInput());
    const b = await service.provisionSession(provisionInput());
    if (!a || !b) throw new Error("expected provisions");

    await service.revokeAll();
    expect(service.validateToken(a.token)).toBe(false);
    expect(service.validateToken(b.token)).toBe(false);
  });

  it("gcStaleSessions strips the daintree entry from project-hash dirs whose token isn't in memory (post-restart cleanup)", async () => {
    // Models the post-restart state: a previous run left a .mcp.json with
    // a literal Bearer token whose in-memory record didn't survive boot.
    // The dir must stay (workspace-trust survives), but the entry has to
    // go before a stray `claude` in that cwd reads it and 401s.
    const sessionsRoot = path.join(userData, "help-sessions");
    const staleDir = path.join(sessionsRoot, "deadbeefdeadbeef");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(
      path.join(staleDir, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            daintree: {
              type: "sse",
              url: "http://127.0.0.1:45454/sse",
              headers: { Authorization: "Bearer dead-token-from-prior-boot" },
            },
            "daintree-docs": { type: "http", url: "https://daintree.org/api/mcp" },
          },
        },
        null,
        2
      )
    );

    await service.gcStaleSessions();

    await fs.access(staleDir);
    const cleaned = JSON.parse(await fs.readFile(path.join(staleDir, ".mcp.json"), "utf-8"));
    expect(cleaned.mcpServers.daintree).toBeUndefined();
    expect(cleaned.mcpServers["daintree-docs"]).toBeDefined();
  });

  it("gcStaleSessions leaves a live session's daintree entry untouched", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    await service.gcStaleSessions();

    const after = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
    );
    expect(after.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${result.token}`);
  });

  it("gcStaleSessions sweeps legacy UUID-named dirs from the old per-launch model and preserves per-project dirs", async () => {
    // Per-project dirs (16-hex-char path-hash names) persist across launches
    // so the user's Claude workspace-trust acceptance carries over. GC only
    // removes dirs whose names don't match the per-project naming scheme —
    // i.e. legacy UUID-named dirs from the old per-launch model.

    const legacyUuidDir = path.join(
      userData,
      "help-sessions",
      "550e8400-e29b-41d4-a716-446655440000"
    );
    await fs.mkdir(legacyUuidDir, { recursive: true });

    const arbitraryNamedDir = path.join(userData, "help-sessions", "stale-session");
    await fs.mkdir(arbitraryNamedDir, { recursive: true });

    const fresh = await service.provisionSession(provisionInput());
    if (!fresh) throw new Error("expected fresh provision");

    await service.gcStaleSessions();

    for (const dir of [legacyUuidDir, arbitraryNamedDir]) {
      let exists = true;
      try {
        await fs.access(dir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }

    await fs.access(fresh.sessionPath);
  });

  it("returns null when the bundled help folder is unavailable", async () => {
    mockHelpFolderPath.mockReturnValue(null);
    const result = await service.provisionSession(provisionInput());
    expect(result).toBeNull();
  });

  it("starts the MCP server when daintreeControl is true and registry is set", async () => {
    mockMcpServerService.isRunning = false;
    // start() succeeds and flips isRunning so provisionSession completes
    // the post-start readiness check.
    mockMcpServerService.start.mockImplementationOnce(async () => {
      mockMcpServerService.isRunning = true;
    });
    const fakeRegistry = {} as never;
    service.setMcpRegistry(fakeRegistry);

    await service.provisionSession(provisionInput());
    expect(mockMcpServerService.start).toHaveBeenCalledWith(fakeRegistry);
  });

  it("auto-enables a disabled MCP server before provisioning when daintreeControl is on", async () => {
    // Models the contradictory shipped defaults: daintreeControl true but
    // mcpServer.enabled false. ensureMcpServerReady must coerce-enable so
    // the assistant doesn't launch with a broken `.mcp.json`.
    mockMcpServerService.enabled = false;
    mockMcpServerService.isRunning = false;
    mockMcpServerService.setEnabled.mockImplementationOnce(async (next: boolean) => {
      mockMcpServerService.enabled = next;
      mockMcpServerService.isRunning = true;
    });

    const result = await service.provisionSession(provisionInput());
    expect(mockMcpServerService.setEnabled).toHaveBeenCalledWith(true);
    expect(result?.mcpUrl).toBe("http://127.0.0.1:45454/sse");
  });

  it("throws MCP_NOT_READY when the MCP server cannot be wired", async () => {
    mockMcpServerService.isRunning = false;
    // setEnabled appears to succeed but isRunning stays false — models a
    // failed bind (port exhaustion, etc).
    mockMcpServerService.enabled = false;
    mockMcpServerService.setEnabled.mockResolvedValueOnce(undefined);
    const failed: McpRuntimeSnapshot = {
      enabled: true,
      state: "failed",
      port: null,
      lastError: "port collision",
    };
    mockMcpServerService.getRuntimeState.mockReturnValueOnce(failed);

    await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
      name: "HelpSessionError",
      code: "MCP_NOT_READY",
    });
  });
});
