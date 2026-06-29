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
    setHelpSessionIdResolver: vi.fn(),
    setSessionIdResolver: vi.fn(),
    disconnectHelpBearer: vi.fn(),
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
          "NotebookEdit(**)",
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
  await fs.writeFile(path.join(helpDir, "CLAUDE.md"), "# Help");
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
    mockMcpServerService.disconnectHelpBearer.mockClear();
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
    // Claude Code's `${VAR}` substitution in `headers` is still broken as of
    // v2.1.83 through v2.1.133 (anthropics/claude-code#6204) and `mcp
    // add/remove` rewrite it to a literal env value, leaking the bearer to disk
    // (#18692, #57131) — must bake the literal token. Same reason as
    // McpPaneConfigService.ts.
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

  it("provisions the Daintree Assistant at the system tier regardless of the stored setting", async () => {
    // Selecting the Daintree Assistant grants full capability (system tier),
    // overriding the action-tier floor that governs the Claude/Codex help
    // overlays. The stored setting here says `action`; the agent identity wins.
    mockStoreGet.mockReturnValue({ tier: "action", bypassPermissions: false });

    const result = await service.provisionSession({
      ...provisionInput(),
      agentId: "daintree-assistant",
    });
    if (!result) throw new Error("expected result");
    expect(result.tier).toBe("system");
  });

  it("leaves non-assistant help agents on the stored action tier", async () => {
    // Contrast with the Daintree Assistant override above: a Claude help overlay
    // keeps the deliberate action floor so irreversible mutations still need a grant.
    mockStoreGet.mockReturnValue({ tier: "action", bypassPermissions: false });

    const result = await service.provisionSession({
      ...provisionInput(),
      agentId: "claude",
    });
    if (!result) throw new Error("expected result");
    expect(result.tier).toBe("action");
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

  it("getDebugLogging returns the snapshot taken at provision time", async () => {
    mockStoreGet.mockReturnValue({ tier: "action", debugLogging: true });

    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    // Mutate the store after provisioning: the accessor must return the
    // value captured at provision time, not re-read the live store.
    mockStoreGet.mockReturnValue({ tier: "action", debugLogging: false });

    expect(service.getDebugLogging(result.token)).toBe(true);
    expect(service.getDebugLogging("not-a-token")).toBe(false);
    expect(service.getDebugLogging("")).toBe(false);

    await service.revokeSession(result.sessionId);
    expect(service.getDebugLogging(result.token)).toBe(false);
  });

  it("getDebugLogging defaults to false when settings have not been touched", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    expect(service.getDebugLogging(result.token)).toBe(false);
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

  it("getActionContextForSessionId returns the snapshot keyed on the public session id and null for unknown / revoked / context-less sessions (#8772)", async () => {
    const withCtx = await service.provisionSession({
      ...provisionInput(),
      actionContext: { focusedWorktreeId: "wt-1", focusedTerminalId: "term-9" },
    });
    if (!withCtx) throw new Error("expected result");

    expect(service.getActionContextForSessionId(withCtx.sessionId)).toEqual({
      focusedWorktreeId: "wt-1",
      focusedTerminalId: "term-9",
    });
    expect(service.getActionContextForSessionId("not-a-real-session")).toBeNull();
    expect(service.getActionContextForSessionId("")).toBeNull();

    await service.revokeSession(withCtx.sessionId);
    expect(service.getActionContextForSessionId(withCtx.sessionId)).toBeNull();

    const noCtx = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-noctx-sid",
      projectPath: "/tmp/proj-noctx-sid",
    });
    if (!noCtx) throw new Error("expected result");
    expect(service.getActionContextForSessionId(noCtx.sessionId)).toBeNull();
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

  it("tears down the live MCP session via disconnectHelpBearer on revoke (#9151)", async () => {
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");

    await service.revokeSession(result.sessionId);

    // The bearer token is handed to McpServerService so it can drop the
    // session's tier/grants/pin immediately instead of leaving them for the
    // 30-minute idle reaper.
    expect(mockMcpServerService.disconnectHelpBearer).toHaveBeenCalledWith(result.token);
  });

  it("tears down the MCP session even when a hibernation resume id is captured (#9151)", async () => {
    mockPtyGracefulKill.mockResolvedValueOnce("resume-id-123");
    const result = await service.provisionSession(provisionInput());
    if (!result) throw new Error("expected result");
    mockMcpServerService.disconnectHelpBearer.mockClear();

    await service.revokeSession(result.sessionId, { captureHibernation: true });

    // The live MCP session is orthogonal to transcript capture — it must be
    // dropped regardless of whether we preserved a resume id.
    expect(mockMcpServerService.disconnectHelpBearer).toHaveBeenCalledWith(result.token);
  });

  it("tears down the displaced session's MCP transport on same-project re-provision (#9151)", async () => {
    const first = await service.provisionSession(provisionInput());
    if (!first) throw new Error("expected first provision");
    mockMcpServerService.disconnectHelpBearer.mockClear();

    // A second provision for the same project displaces the first — its live
    // MCP session must be dropped, not left for the idle reaper.
    const second = await service.provisionSession(provisionInput());
    if (!second) throw new Error("expected second provision");

    expect(mockMcpServerService.disconnectHelpBearer).toHaveBeenCalledWith(first.token);
  });

  it("revokeByWebContentsId drops the MCP session for each matched session (crash/eviction path, #9151)", async () => {
    // Distinct projects so neither provision displaces the other — we want
    // both sessions live and pinned to different WebContents.
    const a = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-a",
      projectPath: "/tmp/proj-a",
      projectViewWebContentsId: 1,
    });
    const b = await service.provisionSession({
      ...provisionInput(),
      projectId: "proj-b",
      projectPath: "/tmp/proj-b",
      projectViewWebContentsId: 2,
    });
    if (!a || !b) throw new Error("expected provisions");
    mockMcpServerService.disconnectHelpBearer.mockClear();

    await service.revokeByWebContentsId(1);

    expect(mockMcpServerService.disconnectHelpBearer).toHaveBeenCalledWith(a.token);
    expect(mockMcpServerService.disconnectHelpBearer).not.toHaveBeenCalledWith(b.token);
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

  it("throws MCP_SERVER_NOT_STARTED when the MCP server cannot be wired", async () => {
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
      code: "MCP_SERVER_NOT_STARTED",
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

  it("throws MCP_SERVER_NOT_STARTED when the active probe fails — passive socket-bound state isn't enough", async () => {
    // Models the exact bug behind #6898: socket is bound (`isRunning` true)
    // but the HTTP/MCP handler hasn't actually serviced a real request yet.
    // The failing probe here is the ensureMcpServerReady self-probe, so the
    // server itself is judged not started.
    mockProbeMcpServer.mockRejectedValueOnce(
      new Error("MCP readiness probe failed after 3 attempt(s) on port 45454: status 500")
    );
    await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
      name: "HelpSessionError",
      code: "MCP_SERVER_NOT_STARTED",
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

  it("throws MCP_PROBE_FAILED and strips the daintree entry when the assistant SSE bearer probe fails", async () => {
    mockProbeMcpSseServer.mockRejectedValueOnce(new Error("SSE returned status 401"));

    await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
      name: "HelpSessionError",
      code: "MCP_PROBE_FAILED",
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

  describe("orphan-bearer sweep (#10698)", () => {
    it("revokes an unbound bearer older than the ceiling and tears down its MCP session", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.validateToken(result.token)).toBe("action");
      // Wire the teardown spy AFTER provisioning — `ensureMcpServerReady` (run
      // during provision) re-sets `onMcpSessionRevoked`, so an earlier spy
      // would be overwritten before the sweep fires.
      const onRevoked = vi.fn();
      service.setOnMcpSessionRevoked(onRevoked);

      // maxAge 0 → cutoff is now, so the just-minted record (createdAt <= now)
      // counts as past-ceiling. It was never bound to a terminal → orphan.
      await service.sweepOrphanSessions(0);

      expect(service.validateToken(result.token)).toBe(false);
      expect(onRevoked).toHaveBeenCalledWith(result.token);
      // No terminal was ever bound, so there's nothing to kill.
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("leaves a freshly provisioned bearer alone (younger than the ceiling)", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      // A generous ceiling means the just-minted record is well within it.
      await service.sweepOrphanSessions(60 * 60 * 1000);

      expect(service.validateToken(result.token)).toBe("action");
    });

    it("never sweeps a bound session regardless of age", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      expect(service.markTerminalForToken(result.token, "term-1")).toBe(true);

      // Even with maxAge 0 (sweep everything past now), the bound session is
      // a healthy live assistant and must survive.
      await service.sweepOrphanSessions(0);

      expect(service.validateToken(result.token)).toBe("action");
      expect(mockPtyKill).not.toHaveBeenCalled();
    });

    it("does not re-revoke an already-revoked session", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");
      // Wire the spy after provision (see note above) so it's the active
      // teardown hook when revokeSession and the sweep run.
      const onRevoked = vi.fn();
      service.setOnMcpSessionRevoked(onRevoked);
      await service.revokeSession(result.sessionId);
      expect(onRevoked).toHaveBeenCalledTimes(1);

      // The revoked record was already dropped from the index, so the sweep
      // can't see it and the teardown callback never fires a second time.
      await service.sweepOrphanSessions(0);

      expect(onRevoked).toHaveBeenCalledTimes(1);
    });

    it("startOrphanSweep arms a periodic sweep that dispose tears down", () => {
      vi.useFakeTimers();
      const svc = new HelpSessionService();
      svc.setMcpRegistry({} as never);
      const sweepSpy = vi.spyOn(svc, "sweepOrphanSessions").mockResolvedValue(undefined);
      try {
        svc.startOrphanSweep();
        svc.startOrphanSweep(); // idempotent — must not arm a second timer

        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(sweepSpy).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(sweepSpy).toHaveBeenCalledTimes(2);

        svc.dispose();
        vi.advanceTimersByTime(15 * 60 * 1000);
        expect(sweepSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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
      // #9639: an empty-sentinel placeholder is written SYNCHRONOUSLY before
      // gracefulKill so a racing switch-back resumes rather than fresh-launches;
      // the real resume ID overwrites it once gracefulKill resolves.
      const setCalls = hibernationStore.set.mock.calls.filter((c) => c[0] === "proj-evicted");
      expect(setCalls[0][1].agentSessionId).toBe("");
      expect(setCalls[setCalls.length - 1][1]).toEqual(
        expect.objectContaining({
          agentId: "claude",
          agentSessionId: "agent-resume-id-123",
          cwd: result.sessionPath,
        })
      );
      expect(service.validateToken(result.token)).toBe(false);
    });

    it("writes an empty-sentinel placeholder and leaves it intact when gracefulKill returns null", async () => {
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
      // #9639: with no real resume ID, the empty-sentinel placeholder stays —
      // resume-latest on next open beats a fresh launch. Exactly one write
      // (the placeholder), never overwritten.
      const setCalls = hibernationStore.set.mock.calls.filter((c) => c[0] === "proj-no-resume");
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0][1].agentSessionId).toBe("");
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

    it("peekPendingHibernation reads the entry WITHOUT clearing it", async () => {
      hibernationStore.get.mockReturnValue({
        agentId: "claude",
        agentSessionId: "pulled-id",
        cwd: "/help/dir",
        capturedAt: Date.now(),
      });

      const peeked = service.peekPendingHibernation("proj-A");

      expect(peeked).toEqual({
        agentId: "claude",
        agentSessionId: "pulled-id",
        cwd: "/help/dir",
        // Disk-loaded entry has no in-memory panelWasOpen → normalized false
        // so app-restart tokens never drive cold-resume (#10815).
        panelWasOpen: false,
      });
      // The whole point of peek vs take: the entry survives so the launch
      // flow can still consume it via takePendingHibernation.
      expect(hibernationStore.clear).not.toHaveBeenCalled();
    });

    it("peekPendingHibernation returns null when no entry exists", () => {
      hibernationStore.get.mockReturnValueOnce(null);

      expect(service.peekPendingHibernation("proj-empty")).toBeNull();
      expect(hibernationStore.clear).not.toHaveBeenCalled();
    });

    it("peekPendingHibernation surfaces panelWasOpen:true for a this-session capture (#10815)", () => {
      // An in-memory entry stamped by an eviction this session carries the flag
      // — the renderer's pull-on-mount peek reads it to decide whether to
      // auto-reopen and resume on cold switch-back.
      hibernationStore.get.mockReturnValueOnce({
        agentId: "claude",
        agentSessionId: "resume-id",
        cwd: "/help/dir",
        capturedAt: Date.now(),
        panelWasOpen: true,
      });

      expect(service.peekPendingHibernation("proj-A")?.panelWasOpen).toBe(true);
    });

    it("stamps panelWasOpen:true on the captured entry when the panel was reported open (#10815)", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("agent-resume-id-123");

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 99,
        projectId: "proj-open",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-open")).toBe(true);

      // Renderer reported the assistant panel open for this project before the
      // eviction fired.
      service.reportPanelOpen("proj-open", true);

      await service.revokeByWebContentsId(99);
      await Promise.resolve();

      const setCalls = hibernationStore.set.mock.calls.filter((c) => c[0] === "proj-open");
      // Both the synchronous placeholder and the real-resume-id overwrite carry
      // the open flag so a switch-back at any point auto-resumes.
      expect(setCalls[0][1].panelWasOpen).toBe(true);
      expect(setCalls[setCalls.length - 1][1]).toEqual(
        expect.objectContaining({
          agentSessionId: "agent-resume-id-123",
          panelWasOpen: true,
        })
      );
    });

    it("stamps panelWasOpen:false when the panel was not open at eviction (#10815)", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("agent-resume-id-456");

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 98,
        projectId: "proj-closed",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-closed")).toBe(true);

      // No reportPanelOpen(true) for this project — panel was closed.
      await service.revokeByWebContentsId(98);
      await Promise.resolve();

      const setCalls = hibernationStore.set.mock.calls.filter((c) => c[0] === "proj-closed");
      expect(setCalls[setCalls.length - 1][1].panelWasOpen).toBe(false);
    });

    it("reportPanelOpen(false) clears a prior open report so a later eviction does not auto-resume (#10815)", async () => {
      mockPtyGracefulKill.mockResolvedValueOnce("agent-resume-id-789");

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 97,
        projectId: "proj-toggle",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-toggle")).toBe(true);

      service.reportPanelOpen("proj-toggle", true);
      // User closed the panel before switching away.
      service.reportPanelOpen("proj-toggle", false);

      await service.revokeByWebContentsId(97);
      await Promise.resolve();

      const setCalls = hibernationStore.set.mock.calls.filter((c) => c[0] === "proj-toggle");
      expect(setCalls[setCalls.length - 1][1].panelWasOpen).toBe(false);
    });

    it("peekPendingHibernation mid-capture neither consumes the entry nor blocks the real resume-id write", async () => {
      // A switch-back can peek (to render the Resume CTA) while main's
      // gracefulKill is still resolving. Peek must be a pure read: it must NOT
      // clear the entry or release the in-flight capture owner, or the
      // post-gracefulKill finalize would skip writing the agent's real resume
      // id (#9639 ownership guard) and the user would resume nothing.
      let resolveGraceful: (value: string | null) => void = () => {};
      mockPtyGracefulKill.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGraceful = resolve;
          })
      );
      // Surface the #9639 empty-sentinel placeholder the eviction path wrote
      // synchronously before awaiting gracefulKill.
      hibernationStore.get.mockReturnValueOnce({
        agentId: "claude",
        agentSessionId: "",
        cwd: "/help/peek-race",
        capturedAt: Date.now(),
      });

      const sess = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 60,
        projectId: "proj-peek-race",
      });
      if (!sess) throw new Error("expected provision");
      expect(service.markTerminalForToken(sess.token, "term-peek")).toBe(true);

      // Eviction-revoke kicks off and hangs on gracefulKill.
      const revokePromise = service.revokeByWebContentsId(60);

      // Renderer peeks mid-flight — pure read, no consumption.
      const peeked = service.peekPendingHibernation("proj-peek-race");
      expect(peeked).toEqual({
        agentId: "claude",
        agentSessionId: "",
        cwd: "/help/peek-race",
        panelWasOpen: false,
      });
      expect(hibernationStore.clear).not.toHaveBeenCalledWith("proj-peek-race");

      // gracefulKill resolves with the real resume id; because peek left the
      // capture owner intact, finalize still overwrites the placeholder.
      resolveGraceful("real-resume-id");
      await revokePromise;
      await Promise.resolve();

      expect(hibernationStore.set).toHaveBeenCalledWith(
        "proj-peek-race",
        expect.objectContaining({ agentSessionId: "real-resume-id" })
      );
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
      // an old resume ID into pendingHibernation for the same project. The
      // #9639 placeholder was written synchronously, but displacement clears it
      // and releases ownership so the post-gracefulKill overwrite is skipped.
      expect(hibernationStore.set).not.toHaveBeenCalledWith(
        "proj-race",
        expect.objectContaining({ agentSessionId: "stale-resume-id-from-displaced-session" })
      );
      expect(hibernationStore.clear).toHaveBeenCalledWith("proj-race");
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

      // The #9639 placeholder is written synchronously before gracefulKill; the
      // rejection leaves it as the empty-sentinel (no real id to overwrite).
      // Hard kill fires as fallback and the token is dead.
      const setCalls = hibernationStore.set.mock.calls;
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0][1].agentSessionId).toBe("");
      expect(mockPtyKill).toHaveBeenCalledWith("term-pty-down", "help-session-revoked");
      expect(service.validateToken(result.token)).toBe(false);
    });

    it("placeholder is visible to takePendingHibernation before gracefulKill resolves (#9639) and the post-gracefulKill finalize block does NOT overwrite with a stale real id (#10048)", async () => {
      // The core race: eviction's revokeByWebContentsId is fire-and-forget, so
      // the renderer can reopen and call takePendingHibernation while
      // gracefulKill is still in flight. A stateful store proves the synchronous
      // placeholder is observable in that window AND that consuming it
      // invalidates the in-flight capture owner so the finalize block cannot
      // write a stale (already-killed) agent resume id on top of it.
      type PendingHelpHibernationLike = {
        agentId: string;
        agentSessionId: string;
        cwd: string;
        capturedAt: number;
      };
      const backing = new Map<string, PendingHelpHibernationLike>();
      const statefulStore = {
        get: vi.fn((projectId: string) => backing.get(projectId) ?? null),
        set: vi.fn((projectId: string, entry: PendingHelpHibernationLike) => {
          backing.set(projectId, entry);
          return Promise.resolve();
        }),
        clear: vi.fn((projectId: string) => {
          backing.delete(projectId);
          return Promise.resolve();
        }),
      };
      service.setPendingHibernationStore(statefulStore as never);

      let resolveGraceful: (value: string | null) => void = () => {};
      mockPtyGracefulKill.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGraceful = resolve;
          })
      );

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 77,
        projectId: "proj-visible",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-visible")).toBe(true);

      // Kick off eviction-revoke; it hangs on gracefulKill.
      const revokePromise = service.revokeByWebContentsId(77);

      // Before gracefulKill resolves, the renderer's takePendingHibernation
      // sees the empty-sentinel placeholder — so it resumes instead of starting
      // a fresh session (the visible "restart" #9639 fixes).
      const early = await service.takePendingHibernation("proj-visible");
      expect(early).toEqual(
        expect.objectContaining({ agentId: "claude", agentSessionId: "", cwd: result.sessionPath })
      );

      // gracefulKill finally yields the real resume id. Because the renderer
      // already consumed the placeholder, the post-gracefulKill finalize
      // block's ownership guard must fail (#10048) — the stale (already-killed)
      // agent id must not be written back to the persistent store.
      resolveGraceful("real-resume-id-xyz");
      await revokePromise;
      await Promise.resolve();

      expect(backing.get("proj-visible")).toBeUndefined();
    });

    it("placeholder gets overwritten with the real id when no take happens (#9639 baseline — finalize-block still updates an untouched capture)", async () => {
      // Regression guard for #9639: when the renderer does NOT consume the
      // placeholder during the kill window, the post-gracefulKill finalize
      // block is still the legitimate writer of the real resume id (no
      // competing consumer has invalidated ownership).
      type PendingHelpHibernationLike = {
        agentId: string;
        agentSessionId: string;
        cwd: string;
        capturedAt: number;
      };
      const backing = new Map<string, PendingHelpHibernationLike>();
      const statefulStore = {
        get: vi.fn((projectId: string) => backing.get(projectId) ?? null),
        set: vi.fn((projectId: string, entry: PendingHelpHibernationLike) => {
          backing.set(projectId, entry);
          return Promise.resolve();
        }),
        clear: vi.fn((projectId: string) => {
          backing.delete(projectId);
          return Promise.resolve();
        }),
      };
      service.setPendingHibernationStore(statefulStore as never);

      let resolveGraceful: (value: string | null) => void = () => {};
      mockPtyGracefulKill.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGraceful = resolve;
          })
      );

      const result = await service.provisionSession({
        ...provisionInput(),
        projectViewWebContentsId: 78,
        projectId: "proj-no-take",
      });
      if (!result) throw new Error("expected provision");
      expect(service.markTerminalForToken(result.token, "term-no-take")).toBe(true);

      const revokePromise = service.revokeByWebContentsId(78);

      // Sanity: the empty-sentinel placeholder is observable during the kill
      // window, exactly as #9639 promises.
      expect(backing.get("proj-no-take")?.agentSessionId).toBe("");

      // No take happens; gracefulKill yields the real resume id and the
      // finalize block is still the legitimate writer.
      resolveGraceful("real-resume-id-abc");
      await revokePromise;
      await Promise.resolve();

      expect(backing.get("proj-no-take")?.agentSessionId).toBe("real-resume-id-abc");
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

    it("throws MCP_PROBE_FAILED when the post-provision /mcp probe fails", async () => {
      mockProbeMcpServer.mockResolvedValueOnce(undefined); // ensureMcpServerReady
      mockProbeMcpServer.mockRejectedValueOnce(new Error("/mcp returned status 500"));

      await expect(service.provisionSession(codexInput())).rejects.toMatchObject({
        name: "HelpSessionError",
        code: "MCP_PROBE_FAILED",
      });
    });
  });

  describe("deprecated agents (#8811)", () => {
    it("rejects agentId: 'gemini' — deprecated tier is excluded from the wired-list gate", async () => {
      // Gemini was retired from the assistant overlay (#8811): its
      // `supports.tier` is `"deprecated"`, so `getAssistantWiredAgentIds()`
      // no longer lists it and `provisionSession` must refuse to spawn a
      // help session under it. The agent still launches from the main
      // toolbar — only the assistant overlay path is gone.
      await expect(
        service.provisionSession({ ...provisionInput(), agentId: "gemini" })
      ).rejects.toThrow(/not assistant-supported/);
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

    it.each([{ name: "a Claude session", provision: () => provisionInput() }])(
      "getCopilotLaunchArgs returns null for $name (cross-agent defense)",
      async ({ provision }) => {
        const result = await service.provisionSession(provision());
        if (!result) throw new Error("expected result");

        expect(service.getCopilotLaunchArgs(result.token)).toBeNull();
      }
    );

    it("getCopilotLaunchArgs returns null for unknown / revoked tokens", async () => {
      const result = await service.provisionSession(copilotInput());
      if (!result) throw new Error("expected result");

      expect(service.getCopilotLaunchArgs("not-a-real-token")).toBeNull();
      expect(service.getCopilotLaunchArgs("")).toBeNull();

      await service.revokeSession(result.sessionId);
      expect(service.getCopilotLaunchArgs(result.token)).toBeNull();
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

    it("throws MCP_PROBE_FAILED and strips the daintree entry when the Copilot /mcp probe fails", async () => {
      mockProbeMcpServer.mockResolvedValueOnce(undefined); // ensureMcpServerReady
      mockProbeMcpServer.mockRejectedValueOnce(new Error("/mcp returned status 401"));

      await expect(service.provisionSession(copilotInput())).rejects.toMatchObject({
        name: "HelpSessionError",
        code: "MCP_PROBE_FAILED",
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
      // Write in REVERSE order from makeBundledHelpFolder to test stability.
      await fs.writeFile(path.join(altHelp, "AGENTS.md"), "# Agents Help");
      await fs.writeFile(path.join(altHelp, "CLAUDE.md"), "# Help");
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
              "NotebookEdit(**)",
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
        code: "MCP_SERVER_NOT_STARTED",
      });

      expect(mockMcpServerService.recordTurnOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "mcp-not-ready" })
      );
    });

    it("records mcp-not-ready when the post-provision SSE probe fails", async () => {
      mockProbeMcpSseServer.mockRejectedValueOnce(new Error("sse probe 500"));
      await expect(service.provisionSession(provisionInput())).rejects.toMatchObject({
        code: "MCP_PROBE_FAILED",
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

    it("writes the scratch-path addendum into CLAUDE.md and AGENTS.md", async () => {
      const result = await service.provisionSession(provisionInput());
      if (!result) throw new Error("expected result");

      const env = service.getAssistantScratchEnv(result.token);
      const scratchDir = env!.DAINTREE_ASSISTANT_SCRATCH_DIR;

      for (const name of ["CLAUDE.md", "AGENTS.md"]) {
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
