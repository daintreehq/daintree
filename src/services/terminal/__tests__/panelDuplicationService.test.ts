import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalInstance } from "@/store";
import type { AddTerminalOptions } from "@/store/slices/terminalRegistry/types";

vi.mock("@/clients", () => ({
  agentSettingsClient: {
    get: vi.fn(),
  },
}));

vi.mock("@shared/types", () => ({
  generateAgentCommand: vi.fn(
    (_cmd: string, _entry: unknown, agentId: string) => `generated-${agentId}-command`
  ),
}));

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: vi.fn((id: string) => id === "claude" || id === "gemini"),
  getAgentConfig: vi.fn((id: string) =>
    id === "claude"
      ? { command: "claude-cmd" }
      : id === "gemini"
        ? { command: "gemini-cmd" }
        : undefined
  ),
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

describe("panelDuplicationService", () => {
  let buildPanelDuplicateOptions: (
    panel: TerminalInstance,
    location: "grid" | "dock" | "trash"
  ) => Promise<AddTerminalOptions>;

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
    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.browserUrl).toBe("https://example.com");
    expect(result.notePath).toBeUndefined();
    expect(result.devCommand).toBeUndefined();
  });

  it("includes notes fields for notes panels", async () => {
    const panel = makePanel({
      kind: "notes",
      notePath: "/notes/readme.md",
      noteId: "note-123",
      scope: "worktree",
    } as Partial<TerminalInstance>);

    const result = await buildPanelDuplicateOptions(panel, "dock");

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
    } as Partial<TerminalInstance>);

    const result = await buildPanelDuplicateOptions(panel, "grid");

    expect(result.devCommand).toBe("npm run dev");
    expect(result.browserUrl).toBe("http://localhost:3000");
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
});
