import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import type { BrowserPanelOptions, DevPreviewPanelOptions } from "@shared/types/addPanelOptions";

vi.mock("@/clients", () => ({
  agentSettingsClient: {
    get: vi.fn(),
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
}));

vi.mock("@shared/types", async () => {
  const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
  return {
    ...actual,
    generateAgentCommand: vi.fn(
      (_cmd: string, _entry: unknown, agentId: string) => `generated-${agentId}-command`
    ),
    buildAgentLaunchFlags: vi.fn((_entry: unknown, _agentId: string, options?: unknown) => {
      const presetArgs = (options as { presetArgs?: string[] } | undefined)?.presetArgs ?? [];
      return [...presetArgs];
    }),
  };
});

const getMergedPresetMock = vi.hoisted(() => vi.fn());

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: vi.fn((id: string) => id === "claude" || id === "gemini"),
  getAgentConfig: vi.fn((id: string) =>
    id === "claude"
      ? { command: "claude-cmd", name: "Claude" }
      : id === "gemini"
        ? { command: "gemini-cmd", name: "Gemini" }
        : undefined
  ),
  getMergedPreset: (...args: unknown[]) => getMergedPresetMock(...args),
  // Pass-through sanitizer: in production this blocks PATH/LD_PRELOAD etc.,
  // but for these tests we just need it to return the input unchanged
  // (filtered to string values) so the service can merge globalEnv + presetEnv.
  sanitizeAgentEnv: (env: Record<string, unknown> | undefined) => {
    if (!env || typeof env !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  },
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: {
    getState: vi.fn(() => ({ ccrPresetsByAgent: {} })),
  },
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: {
    getState: vi.fn(() => ({ presetsByAgent: {} })),
  },
}));

afterEach(() => {
  resetStoreAccessorsForTesting();
});

function makePanel(overrides: Partial<PtyPanelData> | Partial<PanelInstance> = {}): PanelInstance {
  return {
    id: "panel-1",
    title: "Test Panel",
    location: "grid",
    kind: "terminal",
    cwd: "/home/user",
    ...overrides,
  } as PanelInstance;
}

describe("buildPanelSnapshotOptions", () => {
  let buildPanelSnapshotOptions: (panel: PanelInstance) => AddPanelOptions | null;

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
      cwd: "/home/user",
      worktreeId: "wt-1",
      exitBehavior: "keep",
      isInputLocked: true,
      agentModelId: "opus",
      command: "bash",
    });
    // agentLaunchFlags should be a new array (deep copy)
    expect(result!.agentLaunchFlags).toEqual(["--flag"]);
    expect(result!.agentLaunchFlags).not.toBe((panel as PtyPanelData).agentLaunchFlags);
  });

  it("drops a spent session-id flag so reopening a closed agent pane can launch", () => {
    // Assignment is one-shot (#11782): reopening with the id the closed pane
    // already used is rejected by the CLI, so the pane would come back dead.
    const sessionId = "4c5d6e7f-8a9b-4c1d-8e2f-3a4b5c6d7e8f";
    const panel = makePanel({
      launchAgentId: "claude",
      command: `claude --session-id '${sessionId}' --verbose`,
    });

    const result = buildPanelSnapshotOptions(panel);

    expect(result!.command).not.toContain("--session-id");
    expect(result!.command).not.toContain(sessionId);
    // Everything else about the launch still reopens as it was.
    expect(result!.command).toContain("--verbose");
  });

  it("carries the title ownership rung verbatim (reopen-last is a restore, not a copy)", () => {
    const locked = makePanel({ command: "bash", title: "My debug shell", titleMode: "user" });
    expect(buildPanelSnapshotOptions(locked)).toMatchObject({
      title: "My debug shell",
      titleMode: "user",
    });

    const pinned = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude-cmd",
      title: "Auth worker",
      titleMode: "custom",
    });
    expect(buildPanelSnapshotOptions(pinned)).toMatchObject({
      title: "Auth worker",
      titleMode: "custom",
    });
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

  it("handles undefined agentLaunchFlags", () => {
    const panel = makePanel({ agentLaunchFlags: undefined });
    const result = buildPanelSnapshotOptions(panel);
    expect(result!.agentLaunchFlags).toBeUndefined();
  });

  it("returns null for broken agent terminals (missing command)", () => {
    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: undefined,
    });
    expect(buildPanelSnapshotOptions(panel)).toBeNull();
  });

  it("returns a plain terminal snapshot when launchAgentId is absent", () => {
    const panel = makePanel({
      kind: "terminal",
      command: "bash",
    });
    const result = buildPanelSnapshotOptions(panel);
    expect(result).toMatchObject({ kind: "terminal", command: "bash" });
    expect(result!.launchAgentId).toBeUndefined();
  });

  it("returns a valid agent terminal snapshot when command and agentId are present", () => {
    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude --flag",
      agentModelId: "opus",
      agentLaunchFlags: ["--verbose"],
    });
    const result = buildPanelSnapshotOptions(panel);
    expect(result).toMatchObject({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude --flag",
      agentModelId: "opus",
      agentLaunchFlags: ["--verbose"],
    });
  });
});

describe("panelDuplicationService", () => {
  let buildPanelDuplicateOptions: (
    panel: PanelInstance,
    location: "grid" | "dock"
  ) => Promise<AddPanelOptions>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { useProjectPresetsStore } = await import("@/store/projectPresetsStore");
    (useProjectPresetsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      presetsByAgent: {},
    });
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

    const panel = makePanel({ kind: "terminal", launchAgentId: "claude", command: "old-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.command).toBe("generated-claude-command");
  });

  it("falls back to existing command when agent settings fetch fails", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error")
    );

    const panel = makePanel({ launchAgentId: "claude", command: "fallback-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.command).toBe("fallback-cmd");
  });

  it("uses existing command for unregistered agents", async () => {
    const panel = makePanel({ launchAgentId: "custom-agent", command: "my-cmd" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.command).toBe("my-cmd");
  });

  it("uses existing command for non-agent panels", async () => {
    const panel = makePanel({ command: "zsh" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.command).toBe("zsh");
  });

  it("includes browserUrl for browser panels", async () => {
    const panel = makePanel({ kind: "browser", browserUrl: "https://example.com" });
    const result = (await buildPanelDuplicateOptions(panel, "grid")) as BrowserPanelOptions;

    expect(result.browserUrl).toBe("https://example.com");
    expect((result as unknown as Record<string, unknown>).devCommand).toBeUndefined();
  });

  it("includes devCommand and browserUrl for dev-preview panels", async () => {
    const panel = makePanel({
      kind: "dev-preview",
      devCommand: "npm run dev",
      browserUrl: "http://localhost:3000",
      devPreviewConsoleOpen: true,
    } as Partial<PanelInstance>);

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

  it("throws when duplicating agent terminal with missing command", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("settings unavailable")
    );

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "unknown-agent",
      command: undefined,
    });
    await expect(buildPanelDuplicateOptions(panel, "grid")).rejects.toThrow(
      /Cannot duplicate agent terminal.*command/
    );
  });

  it("duplicates without agent identity when launchAgentId is absent (plain terminal path)", async () => {
    const panel = makePanel({
      kind: "terminal",
      command: "claude --flag",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.kind).toBe("terminal");
    expect(result.launchAgentId).toBeUndefined();
    expect(result.command).toBe("claude --flag");
  });

  it("propagates preset env from resolveCommandForPanel into duplicate options", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedPresetMock.mockReturnValue({
      id: "user-abc",
      name: "My Preset",
      env: { MY_VAR: "val", ANOTHER: "one" },
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({ MY_VAR: "val", ANOTHER: "one" });
  });

  it("has no env when preset has no env block", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedPresetMock.mockReturnValue({ id: "user-abc", name: "No Env" });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toBeUndefined();
  });

  it("has no env when agentPresetId is absent", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: undefined,
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toBeUndefined();
  });

  // Regression: duplicating must carry forward the agent's globalEnv. The
  // previous implementation only propagated preset.env, so duplicates silently
  // ran against the default backend instead of the user-configured env (e.g.
  // ANTHROPIC_BASE_URL pointed at a proxy).
  it("merges agent globalEnv into duplicate options (not just preset env)", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" },
        },
      },
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: undefined,
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example.com" });
  });

  it("preset env overrides globalEnv on key conflict (mirrors useAgentLauncher)", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: {
        claude: {
          globalEnv: { SHARED_KEY: "global-wins-when-no-preset", EXTRA: "globalExtra" },
        },
      },
    });
    getMergedPresetMock.mockReturnValue({
      id: "user-abc",
      name: "Preset",
      env: { SHARED_KEY: "preset-wins", PRESET_ONLY: "yes" },
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({
      EXTRA: "globalExtra",
      SHARED_KEY: "preset-wins",
      PRESET_ONLY: "yes",
    });
  });

  it("resolves project presets when duplicating a preset-backed agent terminal", async () => {
    const { agentSettingsClient } = await import("@/clients");
    const { useProjectPresetsStore } = await import("@/store/projectPresetsStore");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    (useProjectPresetsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      presetsByAgent: {
        claude: [
          {
            id: "team-blue",
            name: "Team Blue",
            color: "#3366ff",
            env: { TEAM_PROVIDER: "blue" },
            args: ["--provider", "blue"],
          },
        ],
      },
    });
    getMergedPresetMock.mockImplementation(
      (
        _agentId: string,
        presetId: string,
        _custom: unknown,
        _ccr: unknown,
        projectPresets?: Array<{ id: string }>
      ) => projectPresets?.find((preset) => preset.id === presetId)
    );

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "team-blue",
      agentPresetColor: "#old",
    });
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.env).toEqual({ TEAM_PROVIDER: "blue" });
    expect(result.agentPresetColor).toBe("#3366ff");
    expect(result.agentLaunchFlags).toEqual(["--provider", "blue"]);
  });

  // Regression: when a saved agentPresetId no longer resolves (deleted custom
  // preset, CCR route removed), we must not carry stale presetId/color/title
  // forward — otherwise a duplicated default-env panel will be mislabeled as
  // "Claude (Deleted)" and keep the blue swatch from the missing preset.
  it("clears stale preset fields when agentPresetId no longer resolves", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    // Simulate a deleted preset: agentPresetId is set, but getMergedPreset returns undefined.
    getMergedPresetMock.mockReturnValue(undefined);

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-deleted",
      agentPresetColor: "#ff00ff",
      title: "Claude (Deleted Preset)",
    });
    const result = (await buildPanelDuplicateOptions(panel, "grid")) as {
      agentPresetId?: string;
      agentPresetColor?: string;
      title?: string;
    };

    expect(result.agentPresetId).toBeUndefined();
    expect(result.agentPresetColor).toBeUndefined();
    expect(result.title).not.toContain("(Deleted");
  });

  // Ownership rung on duplicates: an explicit name stays pinned on the copy
  // (otherwise detection rewrites "X (copy)" back to the registry name), but
  // a user lock demotes to "custom" — the human named the source, not the copy.
  it("demotes a user-locked rung to custom on the copy", async () => {
    const panel = makePanel({ command: "bash", title: "My debug shell", titleMode: "user" });
    const result = await buildPanelDuplicateOptions(panel, "grid");
    expect(result.titleMode).toBe("custom");
  });

  it("keeps a custom rung pinned and leaves default unpinned on the copy", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });

    const pinned = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude-cmd",
      title: "Auth worker",
      titleMode: "custom",
    });
    expect((await buildPanelDuplicateOptions(pinned, "grid")).titleMode).toBe("custom");

    const unpinned = makePanel({ command: "bash", title: "Terminal" });
    expect((await buildPanelDuplicateOptions(unpinned, "grid")).titleMode).toBeUndefined();
  });

  it("drops the rung with the stale-preset strip (title fell back to the registry name)", async () => {
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedPresetMock.mockReturnValue(undefined);

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-deleted",
      title: "Claude (Deleted Preset)",
      titleMode: "custom",
    });
    expect((await buildPanelDuplicateOptions(panel, "grid")).titleMode).toBeUndefined();
  });
});

// ── adversarial: behavioral overrides must reach generateAgentCommand ─────────
// These tests assert on the arguments passed to the generateAgentCommand spy to
// prove that preset dangerousEnabled / customFlags / inlineMode / args are
// actually merged before the command is built.  Without these tests a silently
// ignored settings arg would hide the bug.

describe("adversarial: behavioral overrides flow to generateAgentCommand in duplication", () => {
  let buildPanelDuplicateOptions: (
    panel: PanelInstance,
    location: "grid" | "dock"
  ) => Promise<AddPanelOptions>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { useProjectPresetsStore } = await import("@/store/projectPresetsStore");
    (useProjectPresetsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      presetsByAgent: {},
    });
    const mod = await import("../panelDuplicationService");
    buildPanelDuplicateOptions = mod.buildPanelDuplicateOptions;
  });

  async function getGenerateAgentCommandSpy() {
    const mod = await import("@shared/types");
    return vi.mocked(mod.generateAgentCommand);
  }

  it("dangerousEnabled=true from preset overrides base false in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { dangerousEnabled: false } },
    });
    getMergedPresetMock.mockReturnValue({
      id: "user-abc",
      name: "Dangerous",
      dangerousEnabled: true,
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    expect(spy).toHaveBeenCalled();
    const entry = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("customFlags from preset overrides empty base in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { customFlags: "" } },
    });
    getMergedPresetMock.mockReturnValue({
      id: "user-abc",
      name: "Flagged",
      customFlags: "--extra-flag",
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.customFlags).toBe("--extra-flag");
  });

  it("inlineMode=false from preset overrides base true in effectiveEntry", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { inlineMode: true } },
    });
    getMergedPresetMock.mockReturnValue({ id: "user-abc", name: "NoInline", inlineMode: false });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0]![1] as Record<string, unknown>;
    // Baked as the tri-state "off" (alt-screen) now (#10876): the preset's
    // alt-screen choice still vetoes the base's inline (true → "on").
    expect(entry.inlineMode).toBe("off");
  });

  it("preset.dangerousEnabled=undefined does NOT clobber base true (undefined guard)", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: { dangerousEnabled: true } },
    });
    getMergedPresetMock.mockReturnValue({ id: "user-abc", name: "NoOverride" });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    const entry = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("preset.args are joined and passed as presetArgs option", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedPresetMock.mockReturnValue({
      id: "user-abc",
      name: "WithArgs",
      args: ["--verbose", "--trace"],
    });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    const opts = spy.mock.calls[0]![3] as Record<string, unknown>;
    expect(opts.presetArgs).toBe("--verbose --trace");
  });

  it("presetArgs is undefined when preset has no args", async () => {
    const spy = await getGenerateAgentCommandSpy();
    const { agentSettingsClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      agents: { claude: {} },
    });
    getMergedPresetMock.mockReturnValue({ id: "user-abc", name: "NoArgs" });

    const panel = makePanel({
      kind: "terminal",
      launchAgentId: "claude",
      agentPresetId: "user-abc",
    });
    await buildPanelDuplicateOptions(panel, "grid");

    const opts = spy.mock.calls[0]![3] as Record<string, unknown>;
    expect(opts.presetArgs).toBeUndefined();
  });
});

describe("inherited worktree cwd resolution (#11854)", () => {
  const stalePath = "/worktrees/source";
  const filedPath = "/worktrees/destination";
  const filedId = "wt-destination";

  let resolveInheritedPanelCwd: (panel: { cwd?: string; worktreeId?: string }) => string;
  let buildPanelSnapshotOptions: (panel: PanelInstance) => AddPanelOptions | null;
  let buildPanelDuplicateOptions: (
    panel: PanelInstance,
    location: "grid" | "dock"
  ) => Promise<AddPanelOptions>;
  let indexReads: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    indexReads = 0;
    const { agentSettingsClient, systemClient } = await import("@/clients");
    (agentSettingsClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ agents: {} });
    (systemClient.getTmpDir as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp");
    const { useCcrPresetsStore } = await import("@/store/ccrPresetsStore");
    (useCcrPresetsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      ccrPresetsByAgent: {},
    });
    const { useProjectPresetsStore } = await import("@/store/projectPresetsStore");
    (useProjectPresetsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      presetsByAgent: {},
    });
    const mod = await import("../panelDuplicationService");
    resolveInheritedPanelCwd = mod.resolveInheritedPanelCwd;
    buildPanelSnapshotOptions = mod.buildPanelSnapshotOptions;
    buildPanelDuplicateOptions = mod.buildPanelDuplicateOptions;
  });

  // Counting reads is what separates "returned the inherited cwd because the
  // index said so" from "never consulted the index at all".
  function useIndex(entries: Array<[string, string]> | null): void {
    setWorktreePathIndexAccessor(() => {
      indexReads += 1;
      return entries === null ? null : new Map(entries);
    });
  }

  describe("resolveInheritedPanelCwd", () => {
    it("reroots a launch root that belongs to a different worktree", () => {
      useIndex([
        [filedId, filedPath],
        ["wt-source", stalePath],
      ]);

      expect(resolveInheritedPanelCwd({ cwd: stalePath, worktreeId: filedId })).toBe(filedPath);
    });

    it("keeps a subdirectory of the filed worktree, which the user chose deliberately", () => {
      useIndex([[filedId, filedPath]]);
      const subdirectory = `${filedPath}/packages/api`;

      expect(resolveInheritedPanelCwd({ cwd: subdirectory, worktreeId: filedId })).toBe(
        subdirectory
      );
    });

    it("does not treat a sibling worktree whose path merely extends the filed one as inside it", () => {
      useIndex([
        [filedId, filedPath],
        ["wt-sibling", `${filedPath}-other`],
      ]);

      expect(resolveInheritedPanelCwd({ cwd: `${filedPath}-other/src`, worktreeId: filedId })).toBe(
        filedPath
      );
    });

    it("keeps a launch root that belongs to no known worktree, which no drag could produce", () => {
      useIndex([[filedId, filedPath]]);

      expect(resolveInheritedPanelCwd({ cwd: "/tmp/scratch", worktreeId: filedId })).toBe(
        "/tmp/scratch"
      );
    });

    it("adopts the filed worktree when the panel carries no launch root at all", () => {
      useIndex([[filedId, filedPath]]);

      expect(resolveInheritedPanelCwd({ cwd: undefined, worktreeId: filedId })).toBe(filedPath);
    });

    it("keeps the launch root when no view store is mounted", () => {
      useIndex(null);

      expect(resolveInheritedPanelCwd({ cwd: stalePath, worktreeId: filedId })).toBe(stalePath);
      expect(indexReads).toBeGreaterThan(0);
    });

    it("keeps the launch root when the filed worktree is no longer indexed", () => {
      useIndex([["wt-unrelated", "/worktrees/unrelated"]]);

      expect(resolveInheritedPanelCwd({ cwd: stalePath, worktreeId: filedId })).toBe(stalePath);
      expect(indexReads).toBeGreaterThan(0);
    });

    it("never consults the index for a worktree-less panel", () => {
      useIndex([[filedId, filedPath]]);

      expect(resolveInheritedPanelCwd({ cwd: stalePath, worktreeId: undefined })).toBe(stalePath);
      expect(indexReads).toBe(0);
    });
  });

  // Every kind whose cwd is a real spawn directory, so each of the changed
  // `cwd:` sites in the duplicate builder is distinguished.
  const spawningPanels: Array<[string, Partial<PanelInstance>]> = [
    ["agent terminal", { kind: "terminal", launchAgentId: "claude", command: "claude --flag" }],
    ["plain terminal", { kind: "terminal", command: "bash" }],
    ["dev-preview", { kind: "dev-preview", devCommand: "npm run dev" }],
  ];

  describe.each(spawningPanels)("buildPanelDuplicateOptions: %s", (_label, overrides) => {
    it("launches in the worktree it is filed under, not the source worktree", async () => {
      useIndex([
        [filedId, filedPath],
        ["wt-source", stalePath],
      ]);
      const panel = makePanel({ ...overrides, cwd: stalePath, worktreeId: filedId });

      const options = await buildPanelDuplicateOptions(panel, "grid");

      expect(options.cwd).toBe(filedPath);
      expect(options.cwd).not.toBe(panel.cwd);
      // The filing id is the input to the fix, never an output of it.
      expect(options.worktreeId).toBe(panel.worktreeId);
    });

    it("keeps a launch root already inside the filed worktree", async () => {
      useIndex([[filedId, filedPath]]);
      const subdirectory = `${filedPath}/packages/api`;
      const panel = makePanel({ ...overrides, cwd: subdirectory, worktreeId: filedId });

      expect((await buildPanelDuplicateOptions(panel, "grid")).cwd).toBe(subdirectory);
    });
  });

  describe.each(spawningPanels)("buildPanelSnapshotOptions: %s", (_label, overrides) => {
    it("leaves the trash-time launch root untouched for the reopen consumer to resolve", () => {
      useIndex([
        [filedId, filedPath],
        ["wt-source", stalePath],
      ]);
      const panel = makePanel({ ...overrides, cwd: stalePath, worktreeId: filedId });

      // Resolving here would freeze one answer into stored state; `terminal.duplicate`
      // re-resolves at reopen against a fresher index.
      expect(buildPanelSnapshotOptions(panel)?.cwd).toBe(stalePath);
      expect(indexReads).toBe(0);
    });
  });

  it("never resolves a directory for browser panels, which own none", async () => {
    useIndex([[filedId, filedPath]]);
    const panel = makePanel({
      kind: "browser",
      browserUrl: "https://example.com",
      cwd: stalePath,
      worktreeId: filedId,
    } as Partial<PanelInstance>);

    const options = await buildPanelDuplicateOptions(panel, "grid");

    expect(options.cwd).not.toBe(filedPath);
    expect(indexReads).toBe(0);
  });
});
