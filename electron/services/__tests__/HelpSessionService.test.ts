import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const { mockUserDataDir, mockHelpFolderPath, mockMcpServerService, mockStoreGet } = vi.hoisted(
  () => ({
    mockUserDataDir: vi.fn<() => string>(),
    mockHelpFolderPath: vi.fn<() => string | null>(),
    mockMcpServerService: {
      isRunning: false,
      currentPort: 45454 as number | null,
      start: vi.fn().mockResolvedValue(undefined),
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
    mockMcpServerService.start.mockClear();

    service = new HelpSessionService();
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

  it("creates a session dir with a .mcp.json that uses bare Bearer ${DAINTREE_MCP_TOKEN}", async () => {
    const result = await service.provisionSession(provisionInput());
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected result");

    const mcpRaw = await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8");
    const mcp = JSON.parse(mcpRaw);
    expect(mcp.mcpServers.daintree).toEqual({
      type: "sse",
      url: "http://127.0.0.1:45454/sse",
      headers: { Authorization: "Bearer ${DAINTREE_MCP_TOKEN}" },
    });
    expect(mcp.mcpServers["daintree-docs"]).toBeDefined();
  });

  it("appends mcp__daintree__* to the bundled allowlist when localMcpEnabled", async () => {
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

  it("omits the daintree MCP server when localMcpEnabled is false", async () => {
    mockStoreGet.mockReturnValue({ localMcpEnabled: false });

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

  it("removes the session dir on revoke", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    await fs.access(result.sessionPath);
    await service.revokeSession(result.sessionId);

    let exists = true;
    try {
      await fs.access(result.sessionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
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

  it("gcStaleSessions removes dirs whose meta.json is missing or expired", async () => {
    // Pre-create a stale session dir on disk (no meta.json)
    const staleDir = path.join(userData, "help-sessions", "stale-session");
    await fs.mkdir(staleDir, { recursive: true });

    // Pre-create an expired session dir with meta.json
    const expiredDir = path.join(userData, "help-sessions", "expired-session");
    await fs.mkdir(expiredDir, { recursive: true });
    await fs.writeFile(
      path.join(expiredDir, "meta.json"),
      JSON.stringify({
        sessionId: "expired-session",
        createdAt: 0,
        expiresAt: 1,
        windowId: 0,
        projectId: "x",
      })
    );

    // A fresh, live session should NOT be touched
    const fresh = await service.provisionSession(provisionInput());
    if (!fresh) throw new Error("expected fresh provision");

    await service.gcStaleSessions();

    let staleExists = true;
    try {
      await fs.access(staleDir);
    } catch {
      staleExists = false;
    }
    expect(staleExists).toBe(false);

    let expiredExists = true;
    try {
      await fs.access(expiredDir);
    } catch {
      expiredExists = false;
    }
    expect(expiredExists).toBe(false);

    await fs.access(fresh.sessionPath);
  });

  it("returns null when the bundled help folder is unavailable", async () => {
    mockHelpFolderPath.mockReturnValue(null);
    const result = await service.provisionSession(provisionInput());
    expect(result).toBeNull();
  });

  it("starts the MCP server when localMcpEnabled is true and registry is set", async () => {
    mockMcpServerService.isRunning = false;
    const fakeRegistry = {} as never;
    service.setMcpRegistry(fakeRegistry);

    await service.provisionSession(provisionInput());
    expect(mockMcpServerService.start).toHaveBeenCalledWith(fakeRegistry);
  });
});
