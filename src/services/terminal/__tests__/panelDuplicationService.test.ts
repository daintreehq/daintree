import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalInstance } from "@/store";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import type {
  BrowserPanelOptions,
  NotesPanelOptions,
  DevPreviewPanelOptions,
} from "@shared/types/addPanelOptions";

vi.mock("@/clients", () => ({
  agentSettingsClient: {
    get: vi.fn(),
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
}));

vi.mock("@shared/types", () => ({
  generateAgentCommand: vi.fn(
    (_cmd: string, _entry: unknown, agentId: string) => `generated-${agentId}-command`
  ),
}));

const getMergedFlavorMock = vi.hoisted(() => vi.fn());

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: vi.fn((id: string) => id === "claude" || id === "gemini"),
  getAgentConfig: vi.fn((id: string) =>
    id === "claude"
      ? { command: "claude-cmd", name: "Claude" }
      : id === "gemini"
        ? { command: "gemini-cmd", name: "Gemini" }
        : undefined
  ),
  getMergedFlavor: (...args: unknown[]) => getMergedFlavorMock(...args),
  // Pass-through sanitizer: in production this blocks PATH/LD_PRELOAD etc.,
  // but for these tests we just need it to return the input unchanged
  // (filtered to string values) so the service can merge globalEnv + flavorEnv.
  sanitizeAgentEnv: (env: Record<string, unknown> | undefined) => {
    if (!env || typeof env !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  },
}));

vi.mock("@/store/ccrFlavorsStore", () => ({
  useCcrFlavorsStore: {
    getState: vi.fn(() => ({ ccrFlavorsByAgent: {} })),
  },
}));

function makePanel(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "panel-1",
    title: "Test Panel",
    location: "grid",
    kind: "terminal",
    type: "terminal",
    cwd: "/home/user",
    ...overrides,
  } as TerminalInstance;
}

describe("buildPanelSnapshotOptions", () => {
  let buildPanelSnapshotOptions: (panel: TerminalInstance) => AddPanelOptions | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../panelDuplicationService");
    buildPanelSnapshotOptions = mod.buildPanelSnapshotOptions;
  });

  it("copies base fields for a plain terminal", () => {
    const panel = makePanel({
      command: "bash",
      worktreeId: "wt-1",
      exitBehavior: "keep",
      isInputLocked: true,
      agentModelId: "opus",
      agentLaunchFlags: ["--flag"],
    });

    const result = buildPanelSnapshotOptions(panel);

    expect(result).toMatchObject({
      kind: "terminal",
      type: "terminal",
      cwd: "/home/user",
      worktreeId: "wt-1",
      exitBehavior: "keep",
      isInputLocked: true,
      agentModelId: "opus",
      command: "bash",
    });
    // agentLaunchFlags should be a new array (deep copy)
    expect(result!.agentLaunchFlags).toEqual(["--flag"]);
    expect(result!.agentLaunchFlags).not.toBe(panel.agentLaunchFlags);
  });

  it("copies title to the snapshot", () => {
    const panel = makePanel({ title: "My Terminal" });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.title).toBe("My Terminal");
  });

  it("does not include location in the snapshot", () => {
    const panel = makePanel({ location: "dock" });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.location).toBeUndefined();
  });

  it("includes kind-specific fields for browser panels", () => {
    const panel = makePanel({
      kind: "browser",
      browserUrl: "https://example.com",
      browserConsoleOpen: true,
    });
    const result = buildPanelSnapshotOptions(panel) as BrowserPanelOptions;
    expect(result.browserUrl).toBe("https://example.com");
    expect(result.browserConsoleOpen).toBe(true);
  });

  it("copies agent fields for agent panels", () => {
    const panel = makePanel({
      agentId: "claude",
      agentModelId: "opus",
      agentLaunchFlags: ["--verbose"],
    });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentId).toBe("claude");
    expect(result!.agentModelId).toBe("opus");
    expect(result!.agentLaunchFlags).toEqual(["--verbose"]);
  });

  it("handles undefined agentLaunchFlags", () => {
    const panel = makePanel({ agentLaunchFlags: undefined });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentLaunchFlags).toBeUndefined();
  });

  it("returns null for broken agent panels (missing command)", () => {
    const panel = makePanel({
      kind: "agent",
      agentId: "claude",
      command: undefined,
    });
    expect(buildPanelSnapshotOptions(panel)).toBeNull();
  });

  it("returns null for broken agent panels (missing agentId)", () => {
    const panel = makePanel({
      kind: "agent",
      agentId: undefined,
      command: "claude --flag",
    });
    expect(buildPanelSnapshotOptions(panel)).toBeNull();
  });

  it("returns a valid agent snapshot when command and agentId are present", () => {
    const panel = makePanel({
      kind: "agent",
      agentId: "claude",
      command: "claude --flag",
      agentModelId: "opus",
      agentLaunchFlags: ["--verbose"],
    });
    const result = buildPanelSnapshotOptions(panel);
    expect(result).toMatchObject({
      kind: "agent",
      agentId: "claude",
      command: "claude --flag",
      agentModelId: "opus",
      agentLaunchFlags: ["--verbose"],
    });
  });

  it("copies agentFlavorId to the snapshot", () => {
    const panel = makePanel({ agentFlavorId: "user-abc" });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentFlavorId).toBe("user-abc");
  });

  it("copies agentFlavorColor to the snapshot", () => {
    const panel = makePanel({ agentFlavorColor: "#ff6600" });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentFlavorColor).toBe("#ff6600");
  });

  it("copies title to the snapshot (preserves 'Claude (FlavorName)' format)", () => {
    const panel = makePanel({ title: "Claude (My Flavor)" });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.title).toBe("Claude (My Flavor)");
  });

  it("omits agentFlavorId when undefined", () => {
    const panel = makePanel({ agentFlavorId: undefined });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentFlavorId).toBeUndefined();
  });
});

describe("panelDuplicationService", () => {
  let buildPanelDuplicateOptions: (
    panel: TerminalInstance,
    location: "grid" | "dock"
  ) => Promise<AddPanelOptions>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../panelDuplicationService");
    buildPanelDuplicateOptions = mod.buildPanelDuplicateOptions;
  });

  it("copies base options for a plain terminal", async () => {
    const panel = makePanel({
      command: "bash",
      worktreeId: "wt-1",
      exitBehavior: "keep",
      isInputLocked: true,
    });

    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result).toMatchObject({
      kind: "terminal",
      type: "terminal",
      cwd: "/home/user",
      worktreeId: "wt-1",
      location: "grid",
      exitBehavior: "keep",
      isInputLocked: true,
      command: "bash",
    });
  });

  it("uses target location rather than source location", async () => {
    const panel = makePanel({ location: "grid" });
    const result = await buildPanelDuplicateOptions(panel, "dock");
    expect(result.location).toBe("dock");
  });

  it("generates agent command for registered agents", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { model: "opus" } },
    });

    const panel = makePanel({ kind: "terminal", agentId: "claude", command: "old-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.command).toBe("generated-claude-command");
  });

  it("falls back to existing command when agent settings fetch fails", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error")
    );

    const panel = makePanel({ agentId: "claude", command: "fallback-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.command).toBe("fallback-cmd");
  });

  it("uses existing command for unregistered agents", async () => {
    const panel = makePanel({ agentId: "custom-agent", command: "my-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.command).toBe("my-cmd");
  });

  it("uses existing command for non-agent panels", async () => {
    const panel = makePanel({ agentId: undefined, command: "zsh" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.command).toBe("zsh");
  });

  it("includes browserUrl for browser panels", async () => {
    const panel = makePanel({ kind: "browser", browserUrl: "https://example.com" });
    const result = (await buildPanelDuplicateOptions(panel, "grid")) as BrowserPanelOptions;

    expect(result.browserUrl).toBe("https://example.com");
    expect((result as unknown as Record<string, unknown>).notePath).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).devCommand).toBeUndefined();
  });

  it("includes notes fields for notes panels", async () => {
    const panel = makePanel({
      kind: "notes",
      notePath: "/notes/readme.md",
      noteId: "note-123",
      scope: "worktree",
    } as Partial<TerminalInstance>);

    const result = (await buildPanelDuplicateOptions(panel, "dock")) as NotesPanelOptions;

    expect(result.notePath).toBe("/notes/readme.md");
    expect(result.noteId).toBe("note-123");
    expect(result.scope).toBe("worktree");
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it("includes devCommand and browserUrl for dev-preview panels", async () => {
    const panel = makePanel({
      kind: "dev-preview",
      devCommand: "npm run dev",
      browserUrl: "http://localhost:3000",
      devPreviewConsoleOpen: true,
    } as Partial<TerminalInstance>);

    const result = (await buildPanelDuplicateOptions(panel, "grid")) as DevPreviewPanelOptions;

    expect(result.devCommand).toBe("npm run dev");
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.devPreviewConsoleOpen).toBe(true);
  });

  it("defaults kind to 'terminal' when panel.kind is undefined", async () => {
    const panel = makePanel({ kind: undefined });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.kind).toBe("terminal");
  });

  it("defaults cwd to empty string when panel.cwd is undefined", async () => {
    const panel = makePanel({ cwd: undefined });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.cwd).toBe("");
  });

  it("throws when duplicating agent panel with missing command", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("settings unavailable")
    );

    const panel = makePanel({
      kind: "agent",
      agentId: "unknown-agent",
      command: undefined,
    });
    await expect(buildPanelDuplicateOptions(panel, "grid")).rejects.toThrow(
      /Cannot duplicate agent panel.*command/
    );
  });

  it("throws when duplicating agent panel with missing agentId", async () => {
    const panel = makePanel({
      kind: "agent",
      agentId: undefined,
      command: "claude --flag",
    });
    await expect(buildPanelDuplicateOptions(panel, "grid")).rejects.toThrow(
      /Cannot duplicate agent panel.*agentId/
    );
  });

  it("copies agentFlavorId to duplicate options", async () => {
    const panel = makePanel({ agentFlavorId: "user-abc" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.agentFlavorId).toBe("user-abc");
  });

  it("copies agentFlavorColor to duplicate options", async () => {
    const panel = makePanel({ agentFlavorColor: "#ff6600" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.agentFlavorColor).toBe("#ff6600");
  });

  it("copies title to duplicate options (preserves 'Agent (Flavor)' format)", async () => {
    const panel = makePanel({ title: "Claude (My Flavor)" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.title).toBe("Claude (My Flavor)");
  });

  it("propagates flavor env from resolveCommandForPanel into duplicate options", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedFlavorMock.mockReturnValue({
      id: "user-abc",
      name: "My Flavor",
      env: { MY_VAR: "val", ANOTHER: "one" },
    });

    const panel = makePanel({
      kind: "agent",
      agentId: "claude",
      agentFlavorId: "user-abc",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({ MY_VAR: "val", ANOTHER: "one" });
  });

  it("has no env when flavor has no env block", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedFlavorMock.mockReturnValue({ id: "user-abc", name: "No Env" });

    const panel = makePanel({
      kind: "agent",
      agentId: "claude",
      agentFlavorId: "user-abc",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toBeUndefined();
  });

  it("has no env when agentFlavorId is absent", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: undefined });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toBeUndefined();
  });

  // Regression: duplicating must carry forward the agent's globalEnv. The
  // previous implementation only propagated flavor.env, so duplicates silently
  // ran against the default backend instead of the user-configured env (e.g.
  // ANTHROPIC_BASE_URL pointed at a proxy).
  it("merges agent globalEnv into duplicate options (not just flavor env)", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" },
        },
      },
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: undefined });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example.com" });
  });

  it("flavor env overrides globalEnv on key conflict (mirrors useAgentLauncher)", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { SHARED_KEY: "global-wins-when-no-flavor", EXTRA: "globalExtra" },
        },
      },
    });
    getMergedFlavorMock.mockReturnValue({
      id: "user-abc",
      name: "Flavor",
      env: { SHARED_KEY: "flavor-wins", FLAVOR_ONLY: "yes" },
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({
      EXTRA: "globalExtra",
      SHARED_KEY: "flavor-wins",
      FLAVOR_ONLY: "yes",
    });
  });

  // Regression: when a saved agentFlavorId no longer resolves (deleted custom
  // flavor, CCR route removed), we must not carry stale flavorId/color/title
  // forward — otherwise a duplicated vanilla-env panel will be mislabeled as
  // "Claude (Deleted)" and keep the blue swatch from the missing flavor.
  it("clears stale flavor fields when agentFlavorId no longer resolves", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    // Simulate a deleted flavor: agentFlavorId is set, but getMergedFlavor returns undefined.
    getMergedFlavorMock.mockReturnValue(undefined);

    const panel = makePanel({
      kind: "agent",
      agentId: "claude",
      agentFlavorId: "user-deleted",
      agentFlavorColor: "#ff00ff",
      title: "Claude (Deleted Flavor)",
    });
    const result = (await buildPanelDuplicateOptions(panel, "grid")) as {
      agentFlavorId?: string;
      agentFlavorColor?: string;
      title?: string;
    };

    expect(result.agentFlavorId).toBeUndefined();
    expect(result.agentFlavorColor).toBeUndefined();
    expect(result.title).not.toContain("(Deleted");
  });
});

// ── adversarial: behavioral overrides must reach generateAgentCommand ─────────
// These tests assert on the arguments passed to the generateAgentCommand spy to
// prove that flavor dangerousEnabled / customFlags / inlineMode / args are
// actually merged before the command is built.  Without these tests a silently
// ignored settings arg would hide the bug.

describe("adversarial: behavioral overrides flow to generateAgentCommand in duplication", () => {
  let buildPanelDuplicateOptions: (
    panel: TerminalInstance,
    location: "grid" | "dock"
  ) => Promise<AddPanelOptions>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../panelDuplicationService");
    buildPanelDuplicateOptions = mod.buildPanelDuplicateOptions;
  });

  async function getGenerateAgentCommandSpy() {
    const mod = await import("@shared/types");
    return vi.mocked(mod.generateAgentCommand);
  }

  it("dangerousEnabled=true from flavor overrides base false in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { dangerousEnabled: false } },
    });
    getMergedFlavorMock.mockReturnValue({
      id: "user-abc",
      name: "Dangerous",
      dangerousEnabled: true,
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    expect(spy).toHaveBeenCalled();
    const entry = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("customFlags from flavor overrides empty base in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { customFlags: "" } },
    });
    getMergedFlavorMock.mockReturnValue({
      id: "user-abc",
      name: "Flagged",
      customFlags: "--extra-flag",
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.customFlags).toBe("--extra-flag");
  });

  it("inlineMode=false from flavor overrides base true in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { inlineMode: true } },
    });
    getMergedFlavorMock.mockReturnValue({ id: "user-abc", name: "NoInline", inlineMode: false });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.inlineMode).toBe(false);
  });

  it("flavor.dangerousEnabled=undefined does NOT clobber base true (undefined guard)", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { dangerousEnabled: true } },
    });
    getMergedFlavorMock.mockReturnValue({ id: "user-abc", name: "NoOverride" });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("flavor.args are joined and passed as flavorArgs option", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedFlavorMock.mockReturnValue({
      id: "user-abc",
      name: "WithArgs",
      args: ["--verbose", "--trace"],
    });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    const opts = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.flavorArgs).toBe("--verbose --trace");
  });

  it("flavorArgs is undefined when flavor has no args", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedFlavorMock.mockReturnValue({ id: "user-abc", name: "NoArgs" });

    const panel = makePanel({ kind: "agent", agentId: "claude", agentFlavorId: "user-abc" });
    await buildPanelDuplicateOptions(panel, "grid");

    const opts = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.flavorArgs).toBeUndefined();
  });
});
