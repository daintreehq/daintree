import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { McpRuntimeSnapshot } from "../../../shared/types/ipc/mcpServer.js";

const {
  mockUserDataDir,
  mockHelpFolderPath,
  mockMcpServerService,
  mockStoreGet,
  mockProbeMcpServer,
  mockProbeMcpSseServer,
} = vi.hoisted(() => ({
  mockUserDataDir: vi.fn<() => string>(),
  mockHelpFolderPath: vi.fn<() => string | null>(),
  mockMcpServerService: {
    isRunning: true,
    currentPort: 45454 as number | null,
    currentApiKey: "test-api-key" as string | null,
    enabled: true,
    isEnabled() {
      return this.enabled;
    },
    start: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    setHelpTokenValidator: vi.fn(),
    setHelpSessionWebContentsResolver: vi.fn(),
    setHelpSessionActionContextResolver: vi.fn(),
    setSessionIdResolver: vi.fn(),
    recordTurnOutcome: vi.fn(),
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
  mockProbeMcpServer: vi.fn<(port: number, apiKey: string) => Promise<void>>(),
  mockProbeMcpSseServer: vi.fn<(port: number, token: string) => Promise<void>>(),
}));

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

vi.mock("../mcp-server/readinessProbe.js", () => ({
  probeMcpServer: (port: number, apiKey: string) => mockProbeMcpServer(port, apiKey),
  probeMcpSseServer: (port: number, token: string) => mockProbeMcpSseServer(port, token),
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
  await fs.mkdir(path.join(helpDir, ".gemini"), { recursive: true });
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
        allow: [
          "Read(**)",
          "Glob(**)",
          "Grep(**)",
          "LS(**)",
          "WebFetch",
          "mcp__daintree-docs__*",
          "Bash(gh *)",
          "Bash(glab *)",
          "Bash(tea *)",
        ],
        deny: [
          "Write(**)",
          "Edit(**)",
          "MultiEdit(**)",
          "Bash(gh issue create*)",
          "Bash(gh pr create*)",
          "Bash(gh pr merge*)",
          "Bash(gh repo create*)",
          "Bash(gh repo delete*)",
          "Bash(glab issue create*)",
          "Bash(glab mr create*)",
          "Bash(glab mr merge*)",
          "Bash(tea issue create*)",
          "Bash(tea issues create*)",
          "Bash(tea pr create*)",
          "Bash(tea pulls create*)",
          "Bash(tea pulls merge*)",
        ],
      },
    })
  );
  await fs.writeFile(
    path.join(helpDir, ".gemini", "settings.json"),
    JSON.stringify({
      toolsAllowlist: ["read_file", "list_directory", "search_files", "web_search", "shell"],
      mcpServers: {
        "daintree-docs": { httpUrl: "https://daintree.org/api/mcp", trust: true },
      },
    })
  );
  await fs.writeFile(path.join(helpDir, "CLAUDE.md"), "# Help");
  await fs.writeFile(path.join(helpDir, "GEMINI.md"), "# Gemini Help");
  await fs.writeFile(path.join(helpDir, "AGENTS.md"), "# Agents Help");
  return helpDir;
}

/**
 * Removes the scratch-folder addendum block (#7947) plus its trailing
 * whitespace from a markdown file body so a template-body equality assertion
 * can ignore the addendum that `doProvision` appends unconditionally.
 */
function stripScratchAddendum(content: string): string {
  return content
    .replace(
      /\n*<!-- DAINTREE_ASSISTANT_SCRATCH_START -->[\s\S]*?<!-- DAINTREE_ASSISTANT_SCRATCH_END -->\n*/,
      ""
    )
    .replace(/\n+$/, "");
}

describe("HelpSessionService", () => {
  let tmpRoot: string;
  let userData: string;
  let helpFolder: string;
  let service: HelpSessionService;
  let mockPtyKill: ReturnType<typeof vi.fn<(id: string, reason?: string) => void>>;
  let mockPtyGracefulKill: ReturnType<typeof vi.fn<(id: string) => Promise<string | null>>>;

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
    mockMcpServerService.currentApiKey = "test-api-key";
    mockMcpServerService.enabled = true;
    mockMcpServerService.start.mockClear();
    mockMcpServerService.setEnabled.mockClear();
    mockMcpServerService.setHelpTokenValidator.mockClear();
    mockMcpServerService.setHelpSessionWebContentsResolver.mockClear();
    mockMcpServerService.setSessionIdResolver.mockClear();
    mockMcpServerService.recordTurnOutcome.mockClear();
    mockProbeMcpServer.mockReset();
    mockProbeMcpServer.mockResolvedValue(undefined);
    mockProbeMcpSseServer.mockReset();
    mockProbeMcpSseServer.mockResolvedValue(undefined);

    service = new HelpSessionService();
    // The new `ensureMcpServerReady` path throws if no registry is wired —
    // every existing test predates the throw and assumes the wire-up
    // happened during app boot. Set it here so the tests exercise the
    // happy path; one test below intentionally tests the registry-set flow
    // by overriding to a different fakeRegistry.
    service.setMcpRegistry({} as never);
    mockPtyKill = vi.fn();
    // Default: no agent session captured. Tests for capture-on-eviction
    // override this with a real resume ID per-case.
    mockPtyGracefulKill = vi.fn().mockResolvedValue(null);
    service.setPtyClient({ kill: mockPtyKill, gracefulKill: mockPtyGracefulKill });
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
      agentId: "claude",
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

  it("opens the full forge CLI surface without a blanket Bash deny (#8360)", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    // A blanket Bash(**) deny would win over every Bash allow (deny > allow),
    // silently killing the gh/glab/tea allowlist — the #8360 root cause.
    expect(settings.permissions.deny).not.toContain("Bash(**)");
    expect(settings.permissions.allow).toContain("Bash(gh *)");
    expect(settings.permissions.allow).toContain("Bash(glab *)");
    expect(settings.permissions.allow).toContain("Bash(tea *)");
    // All destructive write paths stay hard-blocked — a partial drop of
    // this list must fail the test, not slip through.
    for (const denied of [
      "Bash(gh issue create*)",
      "Bash(gh pr create*)",
      "Bash(gh pr merge*)",
      "Bash(gh repo create*)",
      "Bash(gh repo delete*)",
      "Bash(glab issue create*)",
      "Bash(glab mr create*)",
      "Bash(glab mr merge*)",
      "Bash(tea issue create*)",
      "Bash(tea issues create*)",
      "Bash(tea pr create*)",
      "Bash(tea pulls create*)",
      "Bash(tea pulls merge*)",
    ]) {
      expect(settings.permissions.deny).toContain(denied);
    }
    // Pin the #8360 root-cause pattern: no deny entry may shadow the
    // broad forge allows. Any of these would silently kill the allowlist.
    for (const shadow of ["Bash(*)", "Bash(**)", "Bash(gh *)", "Bash(glab *)", "Bash(tea *)"]) {
      expect(settings.permissions.deny).not.toContain(shadow);
    }
  });

  it("the bundled .claude/settings.json matches the in-code fallback baseline (#8360)", async () => {
    // The fallback in readBundledSettings is the safety net for a corrupted
    // install; if it drifts from the bundled file the #8360 bug reappears
    // whenever the file read fails. Reading the real repo file (not a test
    // fixture) catches that drift.
    // Vitest runs from the repo root, so the real bundled file is at a
    // stable relative path — not a test fixture.
    const bundledPath = path.join(process.cwd(), "help", ".claude", "settings.json");
    const bundled = JSON.parse(await fs.readFile(bundledPath, "utf-8"));

    // Delete the bundled fixture's settings so readBundledSettings is
    // forced down its hardcoded fallback path.
    await fs.rm(path.join(helpFolder, ".claude", "settings.json"));

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    const fallback = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );

    // mcp__daintree__* is appended at provision time; compare the static
    // forge surface only.
    expect(new Set(fallback.permissions.deny)).toEqual(new Set(bundled.permissions.deny));
    for (const allowed of bundled.permissions.allow) {
      expect(fallback.permissions.allow).toContain(allowed);
    }
  });

  it("sets defaultMode=bypassPermissions and tier=system when legacy skipPermissions is true", async () => {
    mockStoreGet.mockReturnValue({ skipPermissions: true });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    expect(result.tier).toBe("system");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.defaultMode).toBe("bypassPermissions");
  });

  it("writes defaultMode=bypassPermissions when bypassPermissions is on but tier stays at action", async () => {
    mockStoreGet.mockReturnValue({ tier: "action", bypassPermissions: true });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    // tier and bypassPermissions are decoupled — action tier with bypass
    // on writes defaultMode but does NOT elevate the MCP tier to system.
    expect(result.tier).toBe("action");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.defaultMode).toBe("bypassPermissions");
  });

  it("does NOT write defaultMode when tier=system but bypassPermissions is off", async () => {
    mockStoreGet.mockReturnValue({ tier: "system", bypassPermissions: false });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    expect(result.tier).toBe("system");

    const settings = JSON.parse(
      await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
    );
    expect(settings.defaultMode).toBeUndefined();
  });

  it("getBypassPermissions returns the snapshot taken at provision time", async () => {
    mockStoreGet.mockReturnValue({ tier: "action", bypassPermissions: true });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    expect(service.getBypassPermissions(result.token)).toBe(true);
    expect(service.getBypassPermissions("not-a-token")).toBe(false);
    expect(service.getBypassPermissions("")).toBe(false);

    await service.revokeSession(result.sessionId);
    expect(service.getBypassPermissions(result.token)).toBe(false);
  });

  it("getBypassPermissions defaults to false when settings have not been touched", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    expect(service.getBypassPermissions(result.token)).toBe(false);
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

  it("getWebContentsIdForToken returns the pin set at provision time and null for unknown / revoked tokens (#7002)", async () => {
    const result = await service.provisionSession({
      ...provisionInput(),
      projectViewWebContentsId: 4242,
    });
    if (!result) throw new Error("expected result");

    expect(service.getWebContentsIdForToken(result.token)).toBe(4242);
    expect(service.getWebContentsIdForToken("not-a-real-token")).toBeNull();
    expect(service.getWebContentsIdForToken("")).toBeNull();

    await service.revokeSession(result.sessionId);
    expect(service.getWebContentsIdForToken(result.token)).toBeNull();
  });

  it("getActionContextForToken returns the provision-time snapshot and null for unknown / revoked / context-less tokens (#8317)", async () => {
    const withCtx = await service.provisionSession({
      ...provisionInput(),
      actionContext: { focusedWorktreeId: "wt-1", focusedTerminalId: "term-9" },
    });
    if (!withCtx) throw new Error("expected result");

    expect(service.getActionContextForToken(withCtx.token)).toEqual({
      focusedWorktreeId: "wt-1",
      focusedTerminalId: "term-9",
    });
    expect(service.getActionContextForToken("not-a-real-token")).toBeNull();
    expect(service.getActionContextForToken("")).toBeNull();

    await service.revokeSession(withCtx.sessionId);
    expect(service.getActionContextForToken(withCtx.token)).toBeNull();

    // A session provisioned without a context snapshot falls back to null so
    // pinned dispatch keeps live context (pre-#8317 behaviour).
    const noCtx = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-noctx",
      projectPath: "/tmp/proj-noctx",
    });
    if (!noCtx) throw new Error("expected result");
    expect(service.getActionContextForToken(noCtx.token)).toBeNull();
  });

  it("getWebContentsIdForToken returns the per-session pin when two sessions are minted from different views", async () => {
    // Distinct projectIds so the single-backend invariant (#7509) doesn't
    // displace `a` when `b` is provisioned. The intent of this test is the
    // per-session WebContents pin, not multi-tenancy of one project.
    const a = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-a",
      projectPath: "/tmp/proj-a",
      projectViewWebContentsId: 100,
    });
    const b = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-b",
      projectPath: "/tmp/proj-b",
      projectViewWebContentsId: 200,
    });
    if (!a || !b) throw new Error("expected provisions");

    expect(service.getWebContentsIdForToken(a.token)).toBe(100);
    expect(service.getWebContentsIdForToken(b.token)).toBe(200);
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

  it("runs the active MCP self-probe before writing .mcp.json when daintreeControl is on", async () => {
    await service.provisionSession(provisionInput());
    expect(mockProbeMcpServer).toHaveBeenCalledWith(45454, "test-api-key");
  });

  it("probes the exact assistant SSE bearer after registering the minted session token", async () => {
    mockProbeMcpSseServer.mockImplementationOnce(async (_port, token) => {
      expect(service.validateToken(token)).toBe("action");
    });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    expect(mockProbeMcpSseServer).toHaveBeenCalledWith(45454, result.token);
  });

  it("skips the active probe when daintreeControl is false", async () => {
    mockStoreGet.mockReturnValue({ daintreeControl: false });
    await service.provisionSession(provisionInput());
    expect(mockProbeMcpServer).not.toHaveBeenCalled();
    expect(mockProbeMcpSseServer).not.toHaveBeenCalled();
  });

  it("throws MCP_NOT_READY when the active probe fails — passive socket-bound state isn't enough", async () => {
    // Models the exact bug behind #6898: socket is bound (`isRunning` true)
    // but the HTTP/MCP handler hasn't actually serviced a real request yet.
    mockProbeMcpServer.mockRejectedValueOnce(
      new Error("MCP readiness probe failed after 3 attempt(s) on port 45454: status 500")
    );
    await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
      name: "HelpSessionError",
      code: "MCP_NOT_READY",
    });
  });

  it("does not write .mcp.json when the active probe fails", async () => {
    mockProbeMcpServer.mockRejectedValueOnce(new Error("probe fail"));
    await expect(service.provisionSession(provisionInput())).rejects.toThrow();

    // The session dir is provisioned only after the readiness gate passes,
    // so neither the dir nor `.mcp.json` should exist on disk.
    const sessionsRoot = path.join(userData, "help-sessions");
    let entries: string[];
    try {
      entries = await fs.readdir(sessionsRoot);
    } catch {
      entries = [];
    }
    expect(entries).toEqual([]);
  });

  it("throws MCP_NOT_READY and strips the daintree entry when the assistant SSE bearer probe fails", async () => {
    mockProbeMcpSseServer.mockRejectedValueOnce(new Error("SSE returned status 401"));

    await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
      name: "HelpSessionError",
      code: "MCP_NOT_READY",
    });

    const token = mockProbeMcpSseServer.mock.calls[0]?.[1];
    expect(token).toBeTypeOf("string");
    expect(service.validateToken(token!)).toBe(false);

    const sessionsRoot = path.join(userData, "help-sessions");
    const entries = await fs.readdir(sessionsRoot);
    expect(entries.length).toBe(1);
    const mcp = JSON.parse(
      await fs.readFile(path.join(sessionsRoot, entries[0]!, ".mcp.json"), "utf-8")
    );
    expect(mcp.mcpServers.daintree).toBeUndefined();
    expect(mcp.mcpServers["daintree-docs"]).toBeDefined();
  });

  describe("single-backend invariant (#7509)", () => {
    it("provisioning a second session for the same project revokes the first token and kills its bound PTY", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");

      expect(service.validateToken(first.token)).toBe(false);
      expect(service.validateToken(second.token)).toBe("action");
      expect(mockPtyKill).toHaveBeenCalledWith("term-1", "help-session-displaced");
    });

    it("provisioning a second session for the same project displaces the first even when no terminal was ever bound", async () => {
      // Models the renderer race where the new provision arrives before
      // `markTerminalForToken` was called for the prior session — bearer
      // is still revoked, no PTY kill (nothing to kill).
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");

      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");

      expect(service.validateToken(first.token)).toBe(false);
      expect(service.validateToken(second.token)).toBe("action");
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("provisioning a session for a different project does not displace the first project's PTY", async () => {
      const first = await service.provisionSession({
        ...provisionInput(),
        projectId: "proj-1",
        projectPath: "/tmp/proj-1",
      });
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      const second = await service.provisionSession({
        ...provisionInput(),
        projectId: "proj-2",
        projectPath: "/tmp/proj-2",
      });
      if (!second) throw new Error("expected second provision");

      expect(service.validateToken(first.token)).toBe("action");
      expect(service.validateToken(second.token)).toBe("action");
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("revokeSession kills the bound PTY", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);

      await service.revokeSession(result.sessionId);

      expect(mockPtyKill).toHaveBeenCalledWith("term-1", "help-session-revoked");
    });

    it("revokeSession is idempotent — kill is called at most once", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);

      await service.revokeSession(result.sessionId);
      await service.revokeSession(result.sessionId);

      expect(mockPtyKill).toHaveBeenCalledTimes(1);
    });

    it("markTerminalForToken returns false for an unknown token without firing kill", async () => {
      expect(service.markTerminalForToken("not-a-token", "term-1")).toBe(false);
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("markTerminalForToken returns false for a revoked token without firing kill", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      await service.revokeSession(result.sessionId);

      expect(service.markTerminalForToken(result.token, "term-1")).toBe(false);
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("markTerminalForToken displaces a stale terminal binding for the same project", async () => {
      // Models the renderer race where two spawn IPCs land back-to-back for
      // the same provisioned session: the second binding must displace the
      // first PTY so the project's slot doesn't end up holding a stale id.
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-old")).toBe(true);
      expect(service.markTerminalForToken(result.token, "term-new")).toBe(true);

      expect(mockPtyKill).toHaveBeenCalledWith("term-old", "help-session-displaced");
    });

    it("PTY kill failures during displacement do not prevent provisioning", async () => {
      mockPtyKill.mockImplementationOnce(() => {
        throw new Error("pty host crashed");
      });
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      const second = await service.provisionSession(provisionInput());
      expect(second).not.toBeNull();
      // Bearer revocation is the security gate; the kill is best-effort.
      expect(service.validateToken(first.token)).toBe(false);
    });

    it("displacement still revokes the prior bearer when no PtyClient is wired", async () => {
      // Cold-boot edge case: provision before the deferred wiring drains.
      // The orphan's MCP calls 401 even without the kill landing.
      service.setPtyClient(null);
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      const second = await service.provisionSession(provisionInput());
      expect(second).not.toBeNull();
      expect(service.validateToken(first.token)).toBe(false);
    });

    it("unbindTerminal removes the binding so a subsequent provision does not kill the unbound PTY", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      service.unbindTerminal("term-1");

      // A second provision for the same project still revokes the first's
      // bearer — but now there is no PTY id to kill.
      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");
      expect(service.validateToken(first.token)).toBe(false);
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("revokeByWebContentsId kills the bound PTY for the matching session", async () => {
      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 99,
      });
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-99")).toBe(true);

      await service.revokeByWebContentsId(99);

      // Default mockPtyGracefulKill returns null (no resume captured), so the
      // existing kill path still fires as a fallback.
      expect(mockPtyGracefulKill).toHaveBeenCalledWith("term-99");
      expect(mockPtyKill).toHaveBeenCalledWith("term-99", "help-session-revoked");
    });
  });

  describe("hibernation capture on eviction (project-switch persistence)", () => {
    let hibernationStore: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      hibernationStore = {
        get: vi.fn().mockReturnValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };
      service.setPendingHibernationStore(hibernationStore as never);
    });

    it("gracefulKills the bound PTY before revoke and writes the captured resume ID", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("agent-resume-id-123");

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 99,
        projectId: "proj-evicted",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-evicted")).toBe(true);

      await service.revokeByWebContentsId(99);
      // setPendingHibernationStore writes via void Promise — let it settle.
      await Promise.resolve();

      expect(mockPtyGracefulKill).toHaveBeenCalledWith("term-evicted");
      // Hard kill is skipped because gracefulKill captured a real ID.
      expect(mockPtyKill).not.toHaveBeenCalled();
      expect(hibernationStore.set).toHaveBeenCalledWith(
        "proj-evicted",
        expect.objectContaining({
          agentId: "claude",
          agentSessionId: "agent-resume-id-123",
          cwd: result.sessionPath,
        })
      );
      expect(service.validateToken(result.token)).toBe(false);
    });

    it("falls back to hard kill when gracefulKill returns null and skips writing a pending entry", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce(null);

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 99,
        projectId: "proj-no-resume",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-no-resume")).toBe(true);

      await service.revokeByWebContentsId(99);
      await Promise.resolve();

      expect(mockPtyKill).toHaveBeenCalledWith("term-no-resume", "help-session-revoked");
      expect(hibernationStore.set).not.toHaveBeenCalled();
    });

    it("does NOT capture on a user-driven revokeSession (newSession / explicit close)", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("never-called");

      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-user-close")).toBe(true);

      // Renderer-driven revoke goes through the bare revokeSession (no
      // captureHibernation flag), so user-discard intent is honoured.
      await service.revokeSession(result.sessionId);

      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
      expect(mockPtyKill).toHaveBeenCalledWith("term-user-close", "help-session-revoked");
      expect(hibernationStore.set).not.toHaveBeenCalled();
    });

    it("captures on revokeByWindowId so multi-window close still preserves the conversation", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("win-close-resume-id");

      const result = await service.provisionSession({ ...provisionInput(), windowId: 42 });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-win")).toBe(true);

      await service.revokeByWindowId(42);
      await Promise.resolve();

      expect(mockPtyGracefulKill).toHaveBeenCalledWith("term-win");
      expect(hibernationStore.set).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ agentSessionId: "win-close-resume-id" })
      );
    });

    it("revokeAll (app shutdown) skips capture to avoid blocking on gracefulKill round-trips", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("never-called");

      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-shutdown")).toBe(true);

      await service.revokeAll();
      await Promise.resolve();

      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
      expect(hibernationStore.set).not.toHaveBeenCalled();
    });

    it("takePendingHibernation reads and clears the entry atomically", async () => {
      hibernationStore.get.mockReturnValueOnce({
        agentId: "claude",
        agentSessionId: "pulled-id",
        cwd: "/help/dir",
        capturedAt: Date.now(),
      });

      const taken = await service.takePendingHibernation("proj-A");

      expect(taken).toEqual({
        agentId: "claude",
        agentSessionId: "pulled-id",
        cwd: "/help/dir",
      });
      expect(hibernationStore.clear).toHaveBeenCalledWith("proj-A");
    });

    it("takePendingHibernation returns null and does not clear when no entry exists", async () => {
      hibernationStore.get.mockReturnValueOnce(null);

      const taken = await service.takePendingHibernation("proj-empty");

      expect(taken).toBeNull();
      expect(hibernationStore.clear).not.toHaveBeenCalled();
    });

    it("skips pending-hibernation write when a same-project provision displaces the record during gracefulKill", async () => {
      // Race we want to defend against:
      //   1. Eviction triggers revokeByWebContentsId for the old session.
      //   2. gracefulKill awaits (slow PTY).
      //   3. User reopens the project — new provision runs displacePriorSessions,
      //      marking the old record revoked.
      //   4. gracefulKill resolves with a captured (now-stale) resume ID.
      //   5. revokeSession MUST NOT write that ID to pendingHibernation, or
      //      the next reopen would resume the discarded conversation instead
      //      of the fresh one the user just started.
      let resolveGraceful: (value: string | null) => void = () => {};
      mockPtyGracefulKill.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGraceful = resolve;
          })
      );

      const first = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 50,
        projectId: "proj-race",
      });
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-old")).toBe(true);

      // Kick off the eviction-revoke; it will hang on gracefulKill.
      const revokePromise = service.revokeByWebContentsId(50);

      // While gracefulKill is in flight, a same-project re-provision lands.
      const second = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 51,
        projectId: "proj-race",
      });
      if (!second) throw new Error("expected second provision");
      // Sanity: displacement already invalidated the old token.
      expect(service.validateToken(first.token)).toBe(false);
      expect(service.validateToken(second.token)).toBe("action");

      // Now let gracefulKill resolve with the captured (stale) resume ID.
      resolveGraceful("stale-resume-id-from-displaced-session");
      await revokePromise;
      await Promise.resolve();

      // The stale capture must NOT clobber the new active session by writing
      // an old resume ID into pendingHibernation for the same project.
      expect(hibernationStore.set).not.toHaveBeenCalled();
    });

    it("a gracefulKill rejection does not abort the eviction revoke — bearer still invalidated", async () => {
      mockPtyGracefulKill.mockRejectedValueOnce(new Error("pty host gone"));

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 5,
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-pty-down")).toBe(true);

      await service.revokeByWebContentsId(5);
      await Promise.resolve();

      // No capture written; hard kill fires as fallback; token is dead.
      expect(hibernationStore.set).not.toHaveBeenCalled();
      expect(mockPtyKill).toHaveBeenCalledWith("term-pty-down", "help-session-revoked");
      expect(service.validateToken(result.token)).toBe(false);
    });
  });

  describe("isHelpTerminal (#7526)", () => {
    it("returns false for unknown / empty terminal ids", () => {
      expect(service.isHelpTerminal("not-a-help-term")).toBe(false);
      expect(service.isHelpTerminal("")).toBe(false);
    });

    it("returns true once a terminal is bound via markTerminalForToken", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.isHelpTerminal("term-1")).toBe(false);

      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);
      expect(service.isHelpTerminal("term-1")).toBe(true);
    });

    it("returns false after unbindTerminal", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);

      service.unbindTerminal("term-1");
      expect(service.isHelpTerminal("term-1")).toBe(false);
    });

    it("returns false after revokeSession", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);

      await service.revokeSession(result.sessionId);
      expect(service.isHelpTerminal("term-1")).toBe(false);
    });

    it("returns false for the displaced terminal after a same-project re-provision", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      expect(service.markTerminalForToken(first.token, "term-1")).toBe(true);

      await service.provisionSession(provisionInput());
      expect(service.isHelpTerminal("term-1")).toBe(false);
    });
  });

  describe("Codex", () => {
    function codexInput() {
      return { ...provisionInput(), agentId: "codex" };
    }

    it("rejects an unknown agentId before any disk writes", async () => {
      await expect(
        service.provisionSession({ ...provisionInput(), agentId: "not-an-agent" })
      ).rejects.toThrow(/not assistant-supported/);
    });

    it("returns a /mcp URL (Streamable HTTP) for Codex assistant launches", async () => {
      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");
      expect(result.mcpUrl).toBe("http://127.0.0.1:45454/mcp");
    });

    it("does NOT write .mcp.json or .codex/config.toml for a Codex provision (Codex uses -c flags, not files)", async () => {
      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      // The bundled help template carries .mcp.json from the help/ folder
      // (copied via fs.cp), so the bundled file exists on disk — but the
      // Codex branch must NOT rewrite it with the Claude-shaped daintree
      // entry that bakes a literal bearer token.
      const mcp = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree).toBeUndefined();

      // Codex doesn't read project-scoped TOML, so a config file is dead
      // weight if written. The Codex branch must not create one.
      let tomlExists = true;
      try {
        await fs.access(path.join(result.sessionPath, ".codex", "config.toml"));
      } catch {
        tomlExists = false;
      }
      expect(tomlExists).toBe(false);
    });

    it("probes /mcp (probeMcpServer) for Codex, not /sse (probeMcpSseServer)", async () => {
      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      // ensureMcpServerReady runs probeMcpServer once with the API key
      // before provision; Codex post-provision also probes /mcp with the
      // session token. Total: probeMcpServer twice, probeMcpSseServer never.
      expect(mockProbeMcpServer).toHaveBeenCalledTimes(2);
      expect(mockProbeMcpServer).toHaveBeenLastCalledWith(45454, result.token);
      expect(mockProbeMcpSseServer).not.toHaveBeenCalled();
    });

    it("getCodexLaunchArgs returns -c flags for both daintree and daintree-docs servers", async () => {
      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      const args = service.getCodexLaunchArgs(result.token);
      expect(args).toEqual([
        "-c",
        'mcp_servers.daintree.transport="http"',
        "-c",
        'mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"',
        "-c",
        'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"',
        "-c",
        'mcp_servers.daintree-docs.transport="http"',
        "-c",
        'mcp_servers.daintree-docs.url="https://daintree.org/api/mcp"',
      ]);
      // Token must NEVER appear in argv — Codex reads it from PTY env via
      // `bearer_token_env_var`.
      expect(args!.join(" ")).not.toContain(result.token);
    });

    it("getCodexLaunchArgs omits the daintree block when daintreeControl is false but keeps daintree-docs", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: false });

      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      const args = service.getCodexLaunchArgs(result.token);
      const flat = args!.join(" ");
      expect(flat).not.toContain("mcp_servers.daintree.");
      expect(flat).toContain("mcp_servers.daintree-docs.");
    });

    it("getCodexLaunchArgs returns [] when both server toggles are off", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: false, docSearch: false });

      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      expect(service.getCodexLaunchArgs(result.token)).toEqual([]);
    });

    it("getCodexLaunchArgs returns null for a Claude session (defense against cross-agent leakage)", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      expect(service.getCodexLaunchArgs(result.token)).toBeNull();
    });

    it("getCodexLaunchArgs returns null for unknown / revoked tokens", async () => {
      const result = await service.provisionSession(codexInput());
      if (!result) throw new Error("expected result");

      expect(service.getCodexLaunchArgs("not-a-real-token")).toBeNull();
      expect(service.getCodexLaunchArgs("")).toBeNull();

      await service.revokeSession(result.sessionId);
      expect(service.getCodexLaunchArgs(result.token)).toBeNull();
    });

    it("revoking a Codex session leaves a sibling Codex session's launch args intact (no shared-file race)", async () => {
      // Two windows opening the same project share one sessionPath. The
      // Claude path needs token-checking on .mcp.json strip to avoid
      // clobbering a live sibling's bearer; the Codex path stores nothing on
      // disk, so a revoke just invalidates the in-memory record.
      const a = await service.provisionSession(codexInput());
      const b = await service.provisionSession(codexInput());
      if (!a || !b) throw new Error("expected provisions");
      expect(a.sessionPath).toBe(b.sessionPath);

      await service.revokeSession(a.sessionId);

      expect(service.getCodexLaunchArgs(a.token)).toBeNull();
      const bArgs = service.getCodexLaunchArgs(b.token);
      expect(bArgs).not.toBeNull();
      expect(bArgs!.length).toBeGreaterThan(0);
    });

    it("throws MCP_NOT_READY when the post-provision /mcp probe fails", async () => {
      mockProbeMcpServer.mockResolvedValueOnce(undefined); // ensureMcpServerReady
      mockProbeMcpServer.mockRejectedValueOnce(new Error("/mcp returned status 500"));

      await expect(service.provisionSession(codexInput())).rejects.toMatchObject({
        name: "HelpSessionError",
        code: "MCP_NOT_READY",
      });
    });
  });

  describe("Gemini (#7542)", () => {
    function geminiInput() {
      return { ...provisionInput(), agentId: "gemini" };
    }

    it("accepts agentId: 'gemini' even though the picker stays Claude/Codex only", async () => {
      const result = await service.provisionSession(geminiInput());
      expect(result).not.toBeNull();
    });

    it("returns the /mcp Streamable HTTP URL for Gemini when daintreeControl is on", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");
      expect(result.mcpUrl).toBe("http://127.0.0.1:45454/mcp");
    });

    it("does NOT rewrite .mcp.json with a Claude-shaped daintree entry", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      // Gemini reads `.gemini/settings.json`, not `.mcp.json` — the latter
      // must not carry a Claude-shaped entry that would only be a stale
      // bearer here.
      const mcp = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree).toBeUndefined();
    });

    it("writes .gemini/settings.json with daintree using httpUrl + ${DAINTREE_MCP_TOKEN} + trust:true", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      const settings = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".gemini", "settings.json"), "utf-8")
      );
      expect(settings.mcpServers.daintree).toEqual({
        httpUrl: "http://127.0.0.1:45454/mcp",
        headers: { Authorization: "Bearer ${DAINTREE_MCP_TOKEN}" },
        trust: true,
      });
      // The bundled docs entry must survive the overlay.
      expect(settings.mcpServers["daintree-docs"]).toEqual({
        httpUrl: "https://daintree.org/api/mcp",
        trust: true,
      });
      // No literal token is ever embedded — the bearer is delivered via
      // PTY env. The literal `${...}` substitution placeholder is the
      // expected form.
      expect(JSON.stringify(settings)).not.toContain(result.token);
      expect(settings.toolsAllowlist).toContain("read_file");
    });

    it("omits the daintree entry from .gemini/settings.json when daintreeControl is off", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: false });

      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      const settings = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".gemini", "settings.json"), "utf-8")
      );
      expect(settings.mcpServers.daintree).toBeUndefined();
      expect(settings.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("omits the daintree-docs entry from .gemini/settings.json when docSearch is off", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: true, docSearch: false });

      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      const settings = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".gemini", "settings.json"), "utf-8")
      );
      expect(settings.mcpServers["daintree-docs"]).toBeUndefined();
      expect(settings.mcpServers.daintree).toBeDefined();
    });

    it("does NOT rewrite .claude/settings.json with help-assistant overrides (Claude-only overlay)", async () => {
      // The bundled template contains the Claude settings file because the
      // template is shared (`fs.cp` copies the whole tree). The Gemini
      // branch must NOT re-overlay it with help-assistant overrides —
      // those carry Claude-only keys (`enableAllProjectMcpServers`,
      // `defaultMode`, `mcp__daintree__*` allow entry) that have no
      // meaning for Gemini and would clutter the on-disk session.
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");
      const settings = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
      );
      expect(settings.enableAllProjectMcpServers).toBeUndefined();
      expect(settings.permissions?.allow ?? []).not.toContain("mcp__daintree__*");
    });

    it("probes /mcp (Streamable HTTP) for Gemini with the session token", async () => {
      // ensureMcpServerReady runs probeMcpServer once with the API key
      // before provision; the Gemini branch then probes /mcp with the
      // freshly minted session token. Total: probeMcpServer twice,
      // probeMcpSseServer never.
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      expect(mockProbeMcpServer).toHaveBeenCalledTimes(2);
      expect(mockProbeMcpServer).toHaveBeenLastCalledWith(45454, result.token);
      expect(mockProbeMcpSseServer).not.toHaveBeenCalled();
    });

    it("getGeminiLaunchArgs returns ['--approval-mode=plan'] for a Gemini session", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      const args = service.getGeminiLaunchArgs(result.token);
      expect(args).toEqual(["--approval-mode=plan"]);
    });

    it("getGeminiLaunchArgs returns null for a Claude session (cross-agent defense)", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiLaunchArgs(result.token)).toBeNull();
    });

    it("getGeminiLaunchArgs returns null for a Codex session (cross-agent defense)", async () => {
      const result = await service.provisionSession({ ...provisionInput(), agentId: "codex" });
      if (!result) throw new Error("expected result");

      expect(service.getGeminiLaunchArgs(result.token)).toBeNull();
    });

    it("getCodexLaunchArgs returns null for a Gemini session (cross-agent defense)", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      expect(service.getCodexLaunchArgs(result.token)).toBeNull();
    });

    it("getGeminiLaunchArgs returns null for unknown / revoked tokens", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiLaunchArgs("not-a-real-token")).toBeNull();
      expect(service.getGeminiLaunchArgs("")).toBeNull();

      await service.revokeSession(result.sessionId);
      expect(service.getGeminiLaunchArgs(result.token)).toBeNull();
    });

    it("getGeminiSpawnEnv returns {} for a Gemini session (intentionally no GEMINI_CLI_HOME)", async () => {
      // Redirecting `os.homedir()` via `GEMINI_CLI_HOME` would break OAuth
      // credential lookup at `~/.gemini/oauth_creds.json`. MCP isolation is
      // achieved via workspace-level `.gemini/settings.json` precedence
      // instead — the shape returned is a typed extension point for
      // future per-agent env without breaking the contract.
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiSpawnEnv(result.token)).toEqual({});
    });

    it("getGeminiSpawnEnv returns null for a Claude session (cross-agent defense)", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiSpawnEnv(result.token)).toBeNull();
    });

    it("getGeminiSpawnEnv returns null for unknown / revoked tokens", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiSpawnEnv("not-a-real-token")).toBeNull();
      expect(service.getGeminiSpawnEnv("")).toBeNull();

      await service.revokeSession(result.sessionId);
      expect(service.getGeminiSpawnEnv(result.token)).toBeNull();
    });

    it("revokeSession strips the daintree entry from .gemini/settings.json", async () => {
      const result = await service.provisionSession(geminiInput());
      if (!result) throw new Error("expected result");

      const target = path.join(result.sessionPath, ".gemini", "settings.json");
      const before = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(before.mcpServers.daintree).toBeDefined();
      expect(before.mcpServers["daintree-docs"]).toBeDefined();

      await service.revokeSession(result.sessionId);

      const after = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(after.mcpServers.daintree).toBeUndefined();
      // The docs entry doesn't depend on a live session.
      expect(after.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("gcStaleSessions strips a stale daintree entry from .gemini/settings.json (post-restart cleanup)", async () => {
      // Models the post-restart state: a previous run left
      // `.gemini/settings.json` carrying the daintree MCP entry whose
      // session record didn't survive boot. The settings file is hygiene
      // only (the literal token is never in the file — it's a
      // `${DAINTREE_MCP_TOKEN}` placeholder), but stripping keeps the CLI
      // from surfacing a configured-but-broken server.
      const sessionsRoot = path.join(userData, "help-sessions");
      const staleDir = path.join(sessionsRoot, "cafebabecafebabe");
      await fs.mkdir(path.join(staleDir, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(staleDir, ".gemini", "settings.json"),
        JSON.stringify(
          {
            mcpServers: {
              daintree: {
                httpUrl: "http://127.0.0.1:45454/mcp",
                headers: { Authorization: "Bearer ${DAINTREE_MCP_TOKEN}" },
                trust: true,
              },
              "daintree-docs": { httpUrl: "https://daintree.org/api/mcp", trust: true },
            },
          },
          null,
          2
        )
      );

      await service.gcStaleSessions();

      await fs.access(staleDir);
      const cleaned = JSON.parse(
        await fs.readFile(path.join(staleDir, ".gemini", "settings.json"), "utf-8")
      );
      expect(cleaned.mcpServers.daintree).toBeUndefined();
      expect(cleaned.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("strips a prior Claude bearer from .mcp.json on Gemini hash-skip switch (no stale Authorization in cwd)", async () => {
      // Provision Claude first — writes `.mcp.json` with a literal Bearer.
      const claudeResult = await service.provisionSession(provisionInput());
      if (!claudeResult) throw new Error("expected claude provision");
      const claudeMcp = JSON.parse(
        await fs.readFile(path.join(claudeResult.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(claudeMcp.mcpServers.daintree.headers.Authorization).toBe(
        `Bearer ${claudeResult.token}`
      );

      // Provision Gemini for the same project. Template hash unchanged →
      // `fs.cp` is skipped. Gemini doesn't rewrite `.mcp.json`, so the dead
      // Claude bearer would survive in cwd without the explicit strip in
      // the Gemini branch.
      const geminiResult = await service.provisionSession(geminiInput());
      if (!geminiResult) throw new Error("expected gemini provision");
      expect(geminiResult.sessionPath).toBe(claudeResult.sessionPath);

      const afterMcp = JSON.parse(
        await fs.readFile(path.join(geminiResult.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(afterMcp.mcpServers.daintree).toBeUndefined();
      expect(afterMcp.mcpServers["daintree-docs"]).toBeDefined();

      // And the new Gemini entry is in .gemini/settings.json.
      const geminiSettings = JSON.parse(
        await fs.readFile(path.join(geminiResult.sessionPath, ".gemini", "settings.json"), "utf-8")
      );
      expect(geminiSettings.mcpServers.daintree.httpUrl).toBe("http://127.0.0.1:45454/mcp");
    });

    it("throws MCP_NOT_READY and strips the daintree entry when the Gemini /mcp probe fails", async () => {
      // First probe call (ensureMcpServerReady) succeeds; second (session
      // token probe) fails.
      mockProbeMcpServer.mockResolvedValueOnce(undefined);
      mockProbeMcpServer.mockRejectedValueOnce(new Error("/mcp returned status 500"));

      await expect(service.provisionSession(geminiInput())).rejects.toMatchObject({
        name: "HelpSessionError",
        code: "MCP_NOT_READY",
      });

      // Session dir survives — but the daintree entry must be gone.
      const sessionsRoot = path.join(userData, "help-sessions");
      const entries = await fs.readdir(sessionsRoot);
      expect(entries.length).toBe(1);
      const settings = JSON.parse(
        await fs.readFile(path.join(sessionsRoot, entries[0]!, ".gemini", "settings.json"), "utf-8")
      );
      expect(settings.mcpServers.daintree).toBeUndefined();
      expect(settings.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("rejects an unknown agentId via the wired-list gate", async () => {
      await expect(
        service.provisionSession({ ...provisionInput(), agentId: "not-an-agent" })
      ).rejects.toThrow(/not assistant-supported/);
    });
  });

  describe("Copilot (#7542)", () => {
    function copilotInput() {
      return { ...provisionInput(), agentId: "copilot" };
    }

    it("accepts agentId: 'copilot'", async () => {
      const result = await service.provisionSession(copilotInput());
      expect(result).not.toBeNull();
    });

    it("returns the /mcp Streamable HTTP URL for Copilot when daintreeControl is on", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");
      expect(result.mcpUrl).toBe("http://127.0.0.1:45454/mcp");
    });

    it("writes .mcp.json with daintree using type:http + url + $DAINTREE_MCP_TOKEN substitution", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      const mcp = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree).toEqual({
        type: "http",
        url: "http://127.0.0.1:45454/mcp",
        // Copilot supports `$VAR` (no braces) — keeps cross-platform portability.
        headers: { Authorization: "Bearer $DAINTREE_MCP_TOKEN" },
      });
      // No literal token on disk — bearer is delivered via PTY env.
      expect(JSON.stringify(mcp)).not.toContain(result.token);
      // docs entry preserved
      expect(mcp.mcpServers["daintree-docs"]).toEqual({
        type: "http",
        url: "https://daintree.org/api/mcp",
      });
    });

    it("omits the daintree entry when daintreeControl is off but keeps daintree-docs", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: false });

      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      const mcp = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree).toBeUndefined();
      expect(mcp.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("omits the daintree-docs entry from .mcp.json when docSearch is off", async () => {
      mockStoreGet.mockReturnValue({ daintreeControl: true, docSearch: false });

      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      const mcp = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers["daintree-docs"]).toBeUndefined();
      expect(mcp.mcpServers.daintree).toBeDefined();
    });

    it("does NOT rewrite .claude/settings.json with help-assistant overrides (Claude-only overlay)", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");
      const settings = JSON.parse(
        await fs.readFile(path.join(result.sessionPath, ".claude", "settings.json"), "utf-8")
      );
      expect(settings.enableAllProjectMcpServers).toBeUndefined();
      expect(settings.permissions?.allow ?? []).not.toContain("mcp__daintree__*");
    });

    it("probes /mcp (Streamable HTTP) for Copilot with the session token", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      expect(mockProbeMcpServer).toHaveBeenCalledTimes(2);
      expect(mockProbeMcpServer).toHaveBeenLastCalledWith(45454, result.token);
      expect(mockProbeMcpSseServer).not.toHaveBeenCalled();
    });

    it("getCopilotLaunchArgs returns ['--plan'] for a Copilot session", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      expect(service.getCopilotLaunchArgs(result.token)).toEqual(["--plan"]);
    });

    it("getCopilotLaunchArgs returns null for a Claude session (cross-agent defense)", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      expect(service.getCopilotLaunchArgs(result.token)).toBeNull();
    });

    it("getCopilotLaunchArgs returns null for a Gemini session (cross-agent defense)", async () => {
      const result = await service.provisionSession({ ...provisionInput(), agentId: "gemini" });
      if (!result) throw new Error("expected result");

      expect(service.getCopilotLaunchArgs(result.token)).toBeNull();
    });

    it("getCopilotLaunchArgs returns null for unknown / revoked tokens", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      expect(service.getCopilotLaunchArgs("not-a-real-token")).toBeNull();
      expect(service.getCopilotLaunchArgs("")).toBeNull();

      await service.revokeSession(result.sessionId);
      expect(service.getCopilotLaunchArgs(result.token)).toBeNull();
    });

    it("getGeminiSpawnEnv returns null for a Copilot session (cross-agent defense)", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      expect(service.getGeminiSpawnEnv(result.token)).toBeNull();
    });

    it("revokeSession strips the daintree entry from .mcp.json", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      const target = path.join(result.sessionPath, ".mcp.json");
      const before = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(before.mcpServers.daintree).toBeDefined();

      await service.revokeSession(result.sessionId);

      const after = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(after.mcpServers.daintree).toBeUndefined();
      expect(after.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("throws MCP_NOT_READY and strips the daintree entry when the Copilot /mcp probe fails", async () => {
      mockProbeMcpServer.mockResolvedValueOnce(undefined); // ensureMcpServerReady
      mockProbeMcpServer.mockRejectedValueOnce(new Error("/mcp returned status 401"));

      await expect(service.provisionSession(copilotInput())).rejects.toMatchObject({
        name: "HelpSessionError",
        code: "MCP_NOT_READY",
      });

      const sessionsRoot = path.join(userData, "help-sessions");
      const entries = await fs.readdir(sessionsRoot);
      expect(entries.length).toBe(1);
      const mcp = JSON.parse(
        await fs.readFile(path.join(sessionsRoot, entries[0]!, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree).toBeUndefined();
      expect(mcp.mcpServers["daintree-docs"]).toBeDefined();
    });
  });

  describe("template hash gate (#7525)", () => {
    /** Mirrors the algorithm in HelpSessionService.computeTemplateHash. */
    async function expectedTemplateHash(folder: string): Promise<string> {
      const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({
          absolute: path.join(entry.parentPath, entry.name),
          relative: path
            .relative(folder, path.join(entry.parentPath, entry.name))
            .split(path.sep)
            .join("/"),
        }))
        .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(file.relative);
        hash.update("\0");
        hash.update(await fs.readFile(file.absolute));
      }
      return hash.digest("hex");
    }

    it("writes a .template-hash stamp on first provision matching the source template hash", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      const stamp = (
        await fs.readFile(path.join(result.sessionPath, ".template-hash"), "utf-8")
      ).trim();
      expect(stamp).toBe(await expectedTemplateHash(helpFolder));
    });

    it("skips fs.cp on a second provision when the template is unchanged, preserving session-dir state", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");

      // Mutate the on-disk template content. If the gate is broken, the
      // second provision will overwrite this with the bundled version.
      await fs.writeFile(path.join(first.sessionPath, "CLAUDE.md"), "# mutated", "utf-8");

      const cpSpy = vi.spyOn(fs, "cp");
      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");
      expect(second.sessionPath).toBe(first.sessionPath);
      // Direct assertion: the gate must short-circuit `fs.cp` entirely,
      // not just preserve the mutated file by chance.
      expect(cpSpy).not.toHaveBeenCalled();

      const claude = await fs.readFile(path.join(second.sessionPath, "CLAUDE.md"), "utf-8");
      // The user's session-dir mutation must be preserved across the
      // hash-gate short-circuit. The scratch-folder addendum is appended
      // unconditionally outside the gate (#7947) — strip it before checking.
      expect(stripScratchAddendum(claude)).toBe("# mutated");
      cpSpy.mockRestore();
    });

    it("re-copies the template when the bundled source hash differs from the on-disk stamp", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      const firstStamp = (
        await fs.readFile(path.join(first.sessionPath, ".template-hash"), "utf-8")
      ).trim();

      // Simulate an app upgrade that updated the bundled help template.
      await fs.writeFile(path.join(helpFolder, "CLAUDE.md"), "# Help v2", "utf-8");

      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");

      const claude = await fs.readFile(path.join(second.sessionPath, "CLAUDE.md"), "utf-8");
      // Strip the unconditional scratch-folder addendum (#7947) before
      // comparing against the bundled template body.
      expect(stripScratchAddendum(claude)).toBe("# Help v2");

      const secondStamp = (
        await fs.readFile(path.join(second.sessionPath, ".template-hash"), "utf-8")
      ).trim();
      expect(secondStamp).toBe(await expectedTemplateHash(helpFolder));
      expect(secondStamp).not.toBe(firstStamp);
    });

    it("does not write the stamp when fs.cp fails — next launch re-copies", async () => {
      // First provision succeeds and writes a valid stamp.
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");

      // Bump the bundled template so the gate triggers another copy on the
      // next provision. Then make `fs.cp` reject — the stamp must not be
      // updated to the new hash, otherwise next launch would skip the copy
      // and leave the session dir torn.
      await fs.writeFile(path.join(helpFolder, "CLAUDE.md"), "# Help v2", "utf-8");
      const cpSpy = vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("disk full"));
      const stampBefore = (
        await fs.readFile(path.join(first.sessionPath, ".template-hash"), "utf-8")
      ).trim();

      await expect(service.provisionSession(provisionInput())).rejects.toThrow();

      // Stamp must still match the pre-failure state, NOT the new source.
      const stampAfter = (
        await fs.readFile(path.join(first.sessionPath, ".template-hash"), "utf-8")
      ).trim();
      expect(stampAfter).toBe(stampBefore);
      cpSpy.mockRestore();
    });

    it("treats a non-ENOENT stamp read failure as missing — provision succeeds and re-copies the template", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");

      // Mutate the session-dir CLAUDE.md so we can detect that fs.cp ran
      // (the bundled value would replace the mutation). Then make the stamp
      // read fail with EACCES — provision must not abort and must re-copy.
      await fs.writeFile(path.join(first.sessionPath, "CLAUDE.md"), "# mutated", "utf-8");

      const stampPath = path.join(first.sessionPath, ".template-hash");
      const realReadFile = fs.readFile.bind(fs);
      const readSpy = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (file: Parameters<typeof fs.readFile>[0], ...rest) => {
          if (file === stampPath) {
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return realReadFile(
            file,
            ...(rest as Parameters<typeof realReadFile> extends [unknown, ...infer R] ? R : never)
          );
        });

      const second = await service.provisionSession(provisionInput());
      expect(second).not.toBeNull();
      readSpy.mockRestore();

      const claude = await fs.readFile(path.join(first.sessionPath, "CLAUDE.md"), "utf-8");
      // Scratch-folder addendum (#7947) is appended unconditionally outside
      // the hash gate. Strip it to compare against the bundled template body.
      expect(stripScratchAddendum(claude)).toBe("# Help");
    });

    it("rewrites .mcp.json with a fresh bearer on every provision, even when the template copy is skipped", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected first provision");
      await service.revokeSession(first.sessionId);

      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected second provision");
      expect(second.token).not.toBe(first.token);

      const mcp = JSON.parse(
        await fs.readFile(path.join(second.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(mcp.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${second.token}`);
    });

    it("strips a prior Claude bearer from .mcp.json on Codex hash-skip switch (no stale Authorization in cwd)", async () => {
      // Provision Claude first — writes `.mcp.json` with a literal Bearer.
      const claudeResult = await service.provisionSession(provisionInput());
      if (!claudeResult) throw new Error("expected claude provision");
      const claudeMcp = JSON.parse(
        await fs.readFile(path.join(claudeResult.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(claudeMcp.mcpServers.daintree.headers.Authorization).toBe(
        `Bearer ${claudeResult.token}`
      );

      // Provision Codex for the same project. Template is unchanged →
      // hash gate skips fs.cp. Codex skips writeMcpConfig. Without the
      // stale-strip in the codex branch, the dead Claude bearer would
      // remain on disk in cwd (regression vs pre-#7525 behavior, where
      // fs.cp would have restored the bundled `.mcp.json`).
      const codexResult = await service.provisionSession({ ...provisionInput(), agentId: "codex" });
      if (!codexResult) throw new Error("expected codex provision");
      expect(codexResult.sessionPath).toBe(claudeResult.sessionPath);

      const after = JSON.parse(
        await fs.readFile(path.join(codexResult.sessionPath, ".mcp.json"), "utf-8")
      );
      expect(after.mcpServers.daintree).toBeUndefined();
      // daintree-docs is not session-bound — must remain.
      expect(after.mcpServers["daintree-docs"]).toBeDefined();
    });

    it("hashes nested template files deterministically (subdir order independence)", async () => {
      // Two help folders with identical content but different on-disk
      // creation order must produce the same hash. The .claude/settings.json
      // file lives one level deep; sorting by full relative path (not just
      // basename) ensures order stability.
      const altHelp = path.join(tmpRoot, "help-alt");
      await fs.mkdir(path.join(altHelp, ".claude"), { recursive: true });
      await fs.mkdir(path.join(altHelp, ".gemini"), { recursive: true });
      // Write in REVERSE order from makeBundledHelpFolder to test stability.
      await fs.writeFile(path.join(altHelp, "GEMINI.md"), "# Gemini Help");
      await fs.writeFile(path.join(altHelp, "AGENTS.md"), "# Agents Help");
      await fs.writeFile(path.join(altHelp, "CLAUDE.md"), "# Help");
      await fs.writeFile(
        path.join(altHelp, ".gemini", "settings.json"),
        JSON.stringify({
          toolsAllowlist: ["read_file", "list_directory", "search_files", "web_search", "shell"],
          mcpServers: {
            "daintree-docs": { httpUrl: "https://daintree.org/api/mcp", trust: true },
          },
        })
      );
      await fs.writeFile(
        path.join(altHelp, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: [
              "Read(**)",
              "Glob(**)",
              "Grep(**)",
              "LS(**)",
              "WebFetch",
              "mcp__daintree-docs__*",
              "Bash(gh *)",
              "Bash(glab *)",
              "Bash(tea *)",
            ],
            deny: [
              "Write(**)",
              "Edit(**)",
              "MultiEdit(**)",
              "Bash(gh issue create*)",
              "Bash(gh pr create*)",
              "Bash(gh pr merge*)",
              "Bash(gh repo create*)",
              "Bash(gh repo delete*)",
              "Bash(glab issue create*)",
              "Bash(glab mr create*)",
              "Bash(glab mr merge*)",
              "Bash(tea issue create*)",
              "Bash(tea issues create*)",
              "Bash(tea pr create*)",
              "Bash(tea pulls create*)",
              "Bash(tea pulls merge*)",
            ],
          },
        })
      );
      await fs.writeFile(
        path.join(altHelp, ".mcp.json"),
        JSON.stringify({
          mcpServers: { "daintree-docs": { type: "http", url: "https://daintree.org/api/mcp" } },
        })
      );

      expect(await expectedTemplateHash(altHelp)).toBe(await expectedTemplateHash(helpFolder));
    });
  });

  describe("turn-outcome wiring (#7541)", () => {
    it("getSessionIdForTerminal returns null for a terminal that was never bound", () => {
      expect(service.getSessionIdForTerminal("term-unbound")).toBeNull();
      expect(service.getSessionIdForTerminal("")).toBeNull();
    });

    it("getSessionIdForTerminal returns the session id after markTerminalForToken", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);
      expect(service.getSessionIdForTerminal("term-1")).toBe(result.sessionId);
    });

    it("getSessionIdForTerminal returns null after the session is revoked", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      service.markTerminalForToken(result.token, "term-1");
      await service.revokeSession(result.sessionId);
      expect(service.getSessionIdForTerminal("term-1")).toBeNull();
    });

    it("wires the session resolver on McpServerService during ensureMcpServerReady", async () => {
      mockStoreGet.mockReset();
      mockStoreGet.mockReturnValue({ daintreeControl: true });
      await service.provisionSession(provisionInput());
      expect(mockMcpServerService.setSessionIdResolver).toHaveBeenCalled();
    });

    it("records a mcp-not-ready turn outcome when ensureMcpServerReady fails", async () => {
      mockStoreGet.mockReset();
      mockStoreGet.mockReturnValue({ daintreeControl: true });
      mockMcpServerService.isRunning = false;
      mockMcpServerService.start.mockResolvedValueOnce(undefined);
      mockMcpServerService.getRuntimeState.mockReturnValue({
        enabled: true,
        state: "failed",
        port: null,
        lastError: "bind failed",
      } satisfies McpRuntimeSnapshot);

      await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
        code: "MCP_NOT_READY",
      });

      expect(mockMcpServerService.recordTurnOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "mcp-not-ready" })
      );
    });

    it("records mcp-not-ready when the post-provision SSE probe fails", async () => {
      mockProbeMcpSseServer.mockRejectedValueOnce(new Error("sse probe 500"));
      await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
        code: "MCP_NOT_READY",
      });
      expect(mockMcpServerService.recordTurnOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "mcp-not-ready" })
      );
    });
  });

  describe("assistant scratch folder", () => {
    it("creates a per-session scratch dir under userData/assistant-scratch", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      const expectedRoot = path.join(userData, "assistant-scratch");
      const stat = await fs.stat(expectedRoot);
      expect(stat.isDirectory()).toBe(true);

      // The exact path is exposed via getAssistantScratchEnv — verify the
      // directory it points at exists and lives under the assistant-scratch
      // root (under a per-instance subdir).
      const env = service.getAssistantScratchEnv(result.token);
      expect(env).not.toBeNull();
      if (!env) throw new Error("expected env");
      const scratchDir = env.DAINTREE_ASSISTANT_SCRATCH_DIR;
      expect(scratchDir).toBeDefined();
      expect(scratchDir.startsWith(expectedRoot + path.sep)).toBe(true);
      const scratchStat = await fs.stat(scratchDir);
      expect(scratchStat.isDirectory()).toBe(true);
    });

    it("exposes DAINTREE_ASSISTANT_SCRATCH_DIR via getAssistantScratchEnv", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      const env = service.getAssistantScratchEnv(result.token);
      expect(env).not.toBeNull();
      expect(env!.DAINTREE_ASSISTANT_SCRATCH_DIR).toMatch(/assistant-scratch/);
    });

    it("returns null from getAssistantScratchEnv for unknown or revoked tokens", async () => {
      expect(service.getAssistantScratchEnv("")).toBeNull();
      expect(service.getAssistantScratchEnv("unknown-token")).toBeNull();

      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      await service.revokeSession(result.sessionId);
      expect(service.getAssistantScratchEnv(result.token)).toBeNull();
    });

    it("writes the scratch-path addendum into CLAUDE.md, AGENTS.md, and GEMINI.md", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      const env = service.getAssistantScratchEnv(result.token);
      const scratchDir = env!.DAINTREE_ASSISTANT_SCRATCH_DIR;

      for (const name of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
        const content = await fs.readFile(path.join(result.sessionPath, name), "utf-8");
        expect(content).toContain("<!-- DAINTREE_ASSISTANT_SCRATCH_START -->");
        expect(content).toContain("<!-- DAINTREE_ASSISTANT_SCRATCH_END -->");
        expect(content).toContain(scratchDir);
        expect(content).toContain("DAINTREE_ASSISTANT_SCRATCH_DIR");
      }
    });

    it("replaces the managed addendum block on re-provision rather than duplicating it", async () => {
      const first = await service.provisionSession(provisionInput());
      if (!first) throw new Error("expected result");
      const second = await service.provisionSession(provisionInput());
      if (!second) throw new Error("expected result");

      // The session dir is reused per-project, so both provisions write into
      // the same CLAUDE.md. The marker block must appear exactly once and
      // contain the second (current) scratch path — never the first.
      const claudeMd = await fs.readFile(path.join(second.sessionPath, "CLAUDE.md"), "utf-8");
      const startMatches = claudeMd.match(/<!-- DAINTREE_ASSISTANT_SCRATCH_START -->/g) ?? [];
      expect(startMatches).toHaveLength(1);

      const firstEnv = service.getAssistantScratchEnv(first.token);
      const secondEnv = service.getAssistantScratchEnv(second.token);
      // First session was displaced (single-backend invariant) — its env
      // getter returns null; the addendum should reference the live session.
      expect(firstEnv).toBeNull();
      expect(secondEnv).not.toBeNull();
      expect(claudeMd).toContain(secondEnv!.DAINTREE_ASSISTANT_SCRATCH_DIR);
    });
  });
});
