import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const getMergedFlavorMock = vi.hoisted(() => vi.fn());

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: (type: string) => ["claude", "gemini", "codex", "opencode"].includes(type),
  getAgentConfig: (id: string) => ({ command: id }),
  getMergedFlavor: (...args: unknown[]) => getMergedFlavorMock(...args),
  // Pass-through: global env sanitization is tested separately in agents-adversarial
  sanitizeAgentEnv: (env: Record<string, unknown> | undefined) => {
    if (!env || typeof env !== "object") return undefined;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") result[k] = v;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  },
}));

vi.mock("@/store/ccrFlavorsStore", () => ({
  useCcrFlavorsStore: {
    getState: vi.fn(() => ({ ccrFlavorsByAgent: {} })),
  },
}));

const buildResumeCommandMock = vi.fn(
  (agentId: string, sessionId: string, _flags?: string[]): string | undefined =>
    `${agentId} --resume ${sessionId}`
);

const generateAgentCommandMock = vi.hoisted(() =>
  vi.fn(
    (base: string, _entry?: unknown, _agentId?: string, _options?: unknown): string =>
      `${base} --generated`
  )
);

vi.mock("@shared/types", async () => {
  const actual = await vi.importActual<typeof import("@shared/types")>("@shared/types");
  return {
    ...actual,
    generateAgentCommand: (base: string, entry: unknown, agentId: string, options: unknown) =>
      generateAgentCommandMock(base, entry, agentId, options),
    buildResumeCommand: (...args: unknown[]) =>
      buildResumeCommandMock(...(args as [string, string, string[]?])),
  };
});

const {
  inferKind,
  inferAgentIdFromTitle,
  resolveAgentId,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
  inferWorktreeIdFromCwd,
} = await import("../statePatcher");

beforeEach(() => {
  buildResumeCommandMock.mockReset();
  buildResumeCommandMock.mockImplementation(
    (agentId: string, sessionId: string) => `${agentId} --resume ${sessionId}`
  );
  generateAgentCommandMock.mockReset();
  generateAgentCommandMock.mockImplementation(
    (base: string, _settings: unknown, _id: string, _opts: unknown) => `${base} --generated`
  );
});

describe("inferKind", () => {
  it("returns saved kind when present", () => {
    expect(inferKind({ id: "t1", kind: "agent" })).toBe("agent");
  });

  it("infers browser from browserUrl", () => {
    expect(inferKind({ id: "t1", browserUrl: "https://example.com" })).toBe("browser");
  });

  it("infers notes from notePath", () => {
    expect(inferKind({ id: "t1", notePath: "/notes/a.md" })).toBe("notes");
  });

  it("infers notes from noteId", () => {
    expect(inferKind({ id: "t1", noteId: "note-1" })).toBe("notes");
  });

  it('infers assistant from title "Assistant"', () => {
    expect(inferKind({ id: "t1", title: "Assistant" })).toBe("assistant");
  });

  it('infers assistant from title starting with "Assistant"', () => {
    expect(inferKind({ id: "t1", title: "Assistant - Chat" })).toBe("assistant");
  });

  it("infers assistant when no cwd and no command", () => {
    expect(inferKind({ id: "t1" })).toBe("assistant");
  });

  it("defaults to terminal when cwd is present", () => {
    expect(inferKind({ id: "t1", cwd: "/home" })).toBe("terminal");
  });

  it("defaults to terminal when command is present", () => {
    expect(inferKind({ id: "t1", command: "ls" })).toBe("terminal");
  });
});

describe("inferAgentIdFromTitle", () => {
  it("returns existing agentId when provided", () => {
    expect(inferAgentIdFromTitle("Claude AI", "agent", "gemini", "t1", "test")).toBe("gemini");
  });

  it("returns undefined for non-agent kind", () => {
    expect(inferAgentIdFromTitle("Claude", "terminal", undefined, "t1", "test")).toBeUndefined();
  });

  it("infers claude from title", () => {
    expect(inferAgentIdFromTitle("Claude Code", "agent", undefined, "t1", "test")).toBe("claude");
  });

  it("infers gemini from title", () => {
    expect(inferAgentIdFromTitle("Gemini Pro", "agent", undefined, "t1", "test")).toBe("gemini");
  });

  it("infers codex from title", () => {
    expect(inferAgentIdFromTitle("Codex CLI", "agent", undefined, "t1", "test")).toBe("codex");
  });

  it("infers opencode from title", () => {
    expect(inferAgentIdFromTitle("OpenCode Terminal", "agent", undefined, "t1", "test")).toBe(
      "opencode"
    );
  });

  it("returns undefined for unrecognized agent title", () => {
    expect(
      inferAgentIdFromTitle("Unknown Agent", "agent", undefined, "t1", "test")
    ).toBeUndefined();
  });
});

describe("resolveAgentId", () => {
  it("returns primary agentId", () => {
    expect(resolveAgentId("claude", undefined)).toBe("claude");
  });

  it("returns primary type when registered", () => {
    expect(resolveAgentId(undefined, "claude")).toBe("claude");
  });

  it("returns fallback agentId", () => {
    expect(resolveAgentId(undefined, undefined, "gemini")).toBe("gemini");
  });

  it("returns fallback type when registered", () => {
    expect(resolveAgentId(undefined, undefined, undefined, "codex")).toBe("codex");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveAgentId(undefined, "bash" as never, undefined, "zsh" as never)).toBeUndefined();
  });
});

describe("buildArgsForBackendTerminal", () => {
  it("builds args from backend terminal data", () => {
    const backend = {
      id: "t1",
      kind: "terminal" as const,
      type: undefined,
      title: "Shell",
      cwd: "/project",
      worktreeId: "wt1",
      agentState: undefined,
      lastStateChange: undefined,
    };
    const saved = {
      id: "t1",
      location: "grid",
      exitBehavior: undefined,
      agentSessionId: undefined,
      agentLaunchFlags: undefined,
    };

    const result = buildArgsForBackendTerminal(backend, saved, "/fallback");
    expect(result.existingId).toBe("t1");
    expect(result.cwd).toBe("/project");
    expect(result.kind).toBe("terminal");
    expect(result.location).toBe("grid");
  });

  it("falls back to projectRoot when backend cwd is empty", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "", title: "Test" },
      { id: "t1", location: "grid" },
      "/project"
    );
    expect(result.cwd).toBe("/project");
  });

  it("includes dev-preview browser fields", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "dev-preview" },
      {
        id: "t1",
        location: "grid",
        command: "npm run dev",
        browserUrl: "http://localhost:3000",
        browserZoom: 1.5,
        devPreviewConsoleOpen: true,
      },
      "/p"
    );
    expect(result.devCommand).toBe("npm run dev");
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.browserZoom).toBe(1.5);
    expect(result.devPreviewConsoleOpen).toBe(true);
  });

  it("excludes browser fields for non-dev-preview", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "terminal" },
      { id: "t1", location: "grid", browserUrl: "http://example.com" },
      "/p"
    );
    expect(result.browserUrl).toBeUndefined();
    expect(result.devCommand).toBeUndefined();
  });

  it("infers agentId from backend title for agent kind", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", title: "Claude Code" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.agentId).toBe("claude");
    expect(result.kind).toBe("agent");
  });

  it("prefers saved title over backend title to preserve user renames", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell" },
      { id: "t1", location: "grid", title: "My Custom Name" },
      "/p"
    );
    expect(result.title).toBe("My Custom Name");
  });

  it("falls back to backend title when saved title is missing", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.title).toBe("Shell");
  });

  it("uses saved worktreeId (renderer-owned layout state)", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", title: "Claude" },
      { id: "t1", location: "grid", worktreeId: "wt-dragged" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-dragged");
  });

  it("returns undefined worktreeId when saved has none", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.worktreeId).toBeUndefined();
  });
});

describe("buildArgsForReconnectedFallback", () => {
  it("merges reconnected terminal with saved data", () => {
    const reconnected = {
      id: "t1",
      cwd: "/reconnected",
      kind: "terminal" as const,
      type: undefined,
      title: "Shell",
    };
    const saved = { id: "t1", location: "dock", worktreeId: "wt-old", title: "Old Title" };

    const result = buildArgsForReconnectedFallback(reconnected, saved, "/fallback");
    expect(result.existingId).toBe("t1");
    expect(result.cwd).toBe("/reconnected");
    expect(result.title).toBe("Old Title");
    expect(result.worktreeId).toBe("wt-old");
    expect(result.location).toBe("dock");
  });

  it("uses saved worktreeId (renderer-owned layout state)", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "agent", title: "Claude" },
      { id: "t1", location: "grid", worktreeId: "wt-dragged" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-dragged");
  });

  it("returns undefined worktreeId when saved has none", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.worktreeId).toBeUndefined();
  });

  it("falls back to saved fields when reconnected is missing data", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1" },
      { id: "t1", cwd: "/saved", title: "Saved", worktreeId: "wt1", location: "grid" },
      "/project"
    );
    expect(result.cwd).toBe("/saved");
    expect(result.title).toBe("Saved");
    expect(result.worktreeId).toBe("wt1");
  });

  it("falls back to reconnected title when saved title is missing", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.title).toBe("Shell");
  });
});

describe("buildArgsForRespawn", () => {
  it("builds respawn args with resume command for agent with session", () => {
    const saved = {
      id: "t1",
      kind: "agent" as const,
      agentId: "claude",
      title: "Claude Code",
      cwd: "/project",
      location: "grid",
      agentSessionId: "sess-123",
      agentLaunchFlags: ["--flag"],
    };

    const result = buildArgsForRespawn(saved, "agent", "/project", { agents: {} }, false, "/tmp");
    expect(result.command).toBe("claude --resume sess-123");
    expect(result.kind).toBe("agent");
    expect(result.requestedId).toBe("t1");
    expect(result.restore).toBe(true);
  });

  it("omits requestedId when reconnect timed out", () => {
    const result = buildArgsForRespawn(
      { id: "t1", kind: "terminal" as const, cwd: "/p", location: "grid" },
      "terminal",
      "/p",
      undefined,
      true,
      undefined
    );
    expect(result.requestedId).toBeUndefined();
  });

  it("generates fresh command for agent without session", () => {
    const result = buildArgsForRespawn(
      { id: "t1", kind: "agent" as const, agentId: "claude", cwd: "/p", location: "grid" },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      "/tmp/clip"
    );
    expect(result.command).toBe("claude --generated");
  });

  it("clears exitBehavior for agent panels", () => {
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        exitBehavior: "keep",
      },
      "agent",
      "/p",
      { agents: {} },
      false,
      undefined
    );
    expect(result.exitBehavior).toBeUndefined();
  });

  it("falls back to fresh command when resume returns undefined", () => {
    buildResumeCommandMock.mockReturnValue(undefined);
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentSessionId: "sess-expired",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      "/tmp/clip"
    );
    expect(result.command).toBe("claude --generated");
    expect(result.kind).toBe("agent");
  });

  it("preserves exitBehavior for non-agent panels", () => {
    const result = buildArgsForRespawn(
      { id: "t1", kind: "terminal" as const, cwd: "/p", location: "grid", exitBehavior: "keep" },
      "terminal",
      "/p",
      undefined,
      false,
      undefined
    );
    expect(result.exitBehavior).toBe("keep");
  });

  it("preserves agentModelId through respawn", () => {
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentModelId: "claude-opus-4-6",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.agentModelId).toBe("claude-opus-4-6");
  });

  it("passes agentLaunchFlags to buildResumeCommand", () => {
    buildResumeCommandMock.mockClear();
    buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentSessionId: "sess-1",
        agentLaunchFlags: ["--yolo", "--dangerously-skip-permissions"],
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(buildResumeCommandMock).toHaveBeenCalledWith("claude", "sess-1", [
      "--yolo",
      "--dangerously-skip-permissions",
    ]);
  });

  it("uses persisted agentLaunchFlags for no-session agent respawn", () => {
    // Sentinel return value would signal the bug (settings path taken instead of flags path)
    generateAgentCommandMock.mockReturnValue("claude --from-settings");
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentLaunchFlags: ["--dangerously-skip-permissions", "--model", "claude-opus-4-7"],
      },
      "agent",
      "/p",
      { agents: { claude: { dangerousEnabled: false } } },
      false,
      "/tmp/clip"
    );
    // `--...` flags pass through raw; the positional `claude-opus-4-7` is escaped.
    expect(result.command).toBe("claude --dangerously-skip-permissions --model 'claude-opus-4-7'");
    expect(generateAgentCommandMock).not.toHaveBeenCalled();
  });

  it("falls back to generateAgentCommand when agentLaunchFlags is empty (pre-fix terminals)", () => {
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentLaunchFlags: [],
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      "/tmp/clip"
    );
    expect(result.command).toBe("claude --generated");
    expect(generateAgentCommandMock).toHaveBeenCalledOnce();
  });

  it("uses persisted agentLaunchFlags when session exists but resume returns undefined", () => {
    buildResumeCommandMock.mockReturnValue(undefined);
    generateAgentCommandMock.mockReturnValue("claude --from-settings");
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentSessionId: "sess-expired",
        agentLaunchFlags: ["--dangerously-skip-permissions"],
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.command).toBe("claude --dangerously-skip-permissions");
    expect(generateAgentCommandMock).not.toHaveBeenCalled();
  });

  it("shell-escapes non-flag tokens in persisted agentLaunchFlags (defends against metachars)", () => {
    // Simulates a user customFlag like `--log /tmp/a;b.log` persisted at launch time.
    // The `/tmp/a;b.log` positional must be quoted so the shell doesn't split on `;`.
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentLaunchFlags: ["--log", "/tmp/a;b.log"],
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.command).toBe("claude --log '/tmp/a;b.log'");
    expect(generateAgentCommandMock).not.toHaveBeenCalled();
  });

  it("re-injects --include-directories for Gemini on respawn (runtime-dynamic, excluded at capture)", () => {
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "gemini",
        cwd: "/p",
        location: "grid",
        agentLaunchFlags: ["--yolo"],
      },
      "agent",
      "/p",
      { agents: { gemini: {} } },
      false,
      "/tmp/daintree-clipboard"
    );
    // Exact assertion locks flag/value pairing and ordering.
    expect(result.command).toBe("gemini --yolo --include-directories '/tmp/daintree-clipboard'");
    expect(generateAgentCommandMock).not.toHaveBeenCalled();
  });

  it("respects shareClipboardDirectory=false for Gemini on respawn", () => {
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent" as const,
        agentId: "gemini",
        cwd: "/p",
        location: "grid",
        agentLaunchFlags: ["--yolo"],
      },
      "agent",
      "/p",
      { agents: { gemini: { shareClipboardDirectory: false } } },
      false,
      "/tmp/daintree-clipboard"
    );
    expect(result.command).not.toContain("--include-directories");
  });
});

describe("agentModelId propagation", () => {
  it("buildArgsForBackendTerminal includes agentModelId", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      {
        id: "t1",
        location: "grid",
        agentModelId: "claude-opus-4-6",
      },
      "/p"
    );
    expect(result.agentModelId).toBe("claude-opus-4-6");
  });

  it("buildArgsForReconnectedFallback includes agentModelId", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p" },
      {
        id: "t1",
        location: "grid",
        agentModelId: "gemini-2.5-pro",
      },
      "/p"
    );
    expect(result.agentModelId).toBe("gemini-2.5-pro");
  });
});

describe("buildArgsForNonPtyRecreation", () => {
  it("builds browser panel args", () => {
    const result = buildArgsForNonPtyRecreation(
      {
        id: "b1",
        kind: "browser",
        title: "Browser",
        browserUrl: "https://example.com",
        browserZoom: 1.2,
        browserConsoleOpen: true,
        location: "grid",
      },
      "browser",
      "/project"
    );
    expect(result.kind).toBe("browser");
    expect(result.browserUrl).toBe("https://example.com");
    expect(result.browserConsoleOpen).toBe(true);
    expect(result.requestedId).toBe("b1");
  });

  it("builds notes panel args", () => {
    const result = buildArgsForNonPtyRecreation(
      {
        id: "n1",
        kind: "notes",
        title: "Notes",
        notePath: "/notes/a.md",
        noteId: "note-1",
        scope: "project",
        createdAt: 12345,
        location: "dock",
      },
      "notes",
      "/project"
    );
    expect(result.kind).toBe("notes");
    expect(result.notePath).toBe("/notes/a.md");
    expect(result.noteId).toBe("note-1");
    expect(result.scope).toBe("project");
    expect(result.location).toBe("dock");
  });

  it("builds dev-preview panel args with devCommand fallback", () => {
    const result = buildArgsForNonPtyRecreation(
      { id: "d1", kind: "dev-preview", title: "Dev", command: "npm start", location: "grid" },
      "dev-preview",
      "/project"
    );
    expect(result.devCommand).toBe("npm start");
  });

  it("prefers devCommand over command for dev-preview", () => {
    const result = buildArgsForNonPtyRecreation(
      {
        id: "d1",
        kind: "dev-preview",
        title: "Dev",
        devCommand: "npm run dev",
        command: "npm start",
        location: "grid",
      },
      "dev-preview",
      "/project"
    );
    expect(result.devCommand).toBe("npm run dev");
  });

  it("forwards extensionState from saved data", () => {
    const extState = { activeTab: "stats", zoom: 1.5 };
    const result = buildArgsForNonPtyRecreation(
      {
        id: "ext-1",
        kind: "my-plugin",
        title: "Plugin",
        location: "grid",
        extensionState: extState,
      },
      "my-plugin",
      "/project"
    );
    expect(result.extensionState).toEqual(extState);
  });

  it("passes undefined extensionState when not present in saved data", () => {
    const result = buildArgsForNonPtyRecreation(
      { id: "b1", kind: "browser", title: "Browser", location: "grid" },
      "browser",
      "/project"
    );
    expect(result.extensionState).toBeUndefined();
  });
});

describe("buildArgsForOrphanedTerminal", () => {
  it("builds args for orphaned terminal", () => {
    const result = buildArgsForOrphanedTerminal(
      {
        id: "t1",
        kind: "terminal",
        type: undefined,
        title: "Shell",
        cwd: "/project",
        agentState: "idle",
        lastStateChange: 12345,
      },
      "/fallback"
    );
    expect(result.existingId).toBe("t1");
    expect(result.location).toBe("grid");
    expect(result.kind).toBe("terminal");
    expect(result.agentState).toBe("idle");
    // Orphan builder returns undefined; caller assigns via cwd inference
    expect(result.worktreeId).toBeUndefined();
  });

  it("infers agent kind from title", () => {
    const result = buildArgsForOrphanedTerminal(
      { id: "t1", kind: "agent", title: "Gemini", cwd: "/p" },
      "/p"
    );
    expect(result.agentId).toBe("gemini");
    expect(result.kind).toBe("agent");
  });

  it("falls back to projectRoot when cwd is empty", () => {
    const result = buildArgsForOrphanedTerminal({ id: "t1", cwd: "", title: "Test" }, "/project");
    expect(result.cwd).toBe("/project");
  });

  it("preserves agentLaunchFlags and agentModelId from backend", () => {
    const result = buildArgsForOrphanedTerminal(
      {
        id: "t1",
        kind: "agent",
        type: "claude",
        agentId: "claude",
        title: "Claude",
        cwd: "/project",
        agentLaunchFlags: ["--dangerously-skip-permissions", "--yolo"],
        agentModelId: "sonnet",
        agentSessionId: "sess-123",
      },
      "/project"
    );
    expect(result.agentLaunchFlags).toEqual(["--dangerously-skip-permissions", "--yolo"]);
    expect(result.agentModelId).toBe("sonnet");
    expect(result.agentSessionId).toBe("sess-123");
  });

  it("handles empty agentLaunchFlags array correctly", () => {
    const result = buildArgsForOrphanedTerminal(
      { id: "t1", kind: "agent", title: "Claude", cwd: "/p", agentLaunchFlags: [] },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual([]);
  });

  it("omits agent fields when not present on backend (backwards compat)", () => {
    const result = buildArgsForOrphanedTerminal(
      { id: "t1", kind: "terminal", title: "Shell", cwd: "/p" },
      "/p"
    );
    expect(result.agentLaunchFlags).toBeUndefined();
    expect(result.agentModelId).toBeUndefined();
    expect(result.agentSessionId).toBeUndefined();
  });
});

describe("inferWorktreeIdFromCwd", () => {
  it("returns the id of the worktree whose path equals cwd", () => {
    const worktrees = [
      { id: "/repo/wt-a", path: "/repo/wt-a" },
      { id: "/repo/wt-b", path: "/repo/wt-b" },
    ];
    expect(inferWorktreeIdFromCwd("/repo/wt-a", worktrees)).toBe("/repo/wt-a");
  });

  it("returns the id of the worktree whose path is a directory prefix of cwd", () => {
    const worktrees = [{ id: "/repo/wt-a", path: "/repo/wt-a" }];
    expect(inferWorktreeIdFromCwd("/repo/wt-a/src/lib", worktrees)).toBe("/repo/wt-a");
  });

  it("picks the longest matching path when multiple worktrees could match", () => {
    const worktrees = [
      { id: "/repo/wt", path: "/repo/wt" },
      { id: "/repo/wt-long", path: "/repo/wt-long" },
    ];
    expect(inferWorktreeIdFromCwd("/repo/wt-long/src", worktrees)).toBe("/repo/wt-long");
  });

  it("does not match sibling directories that share a prefix", () => {
    const worktrees = [{ id: "/repo/wt", path: "/repo/wt" }];
    // "/repo/wt-long" starts with "/repo/wt" as a raw prefix but is not inside it.
    expect(inferWorktreeIdFromCwd("/repo/wt-long/src", worktrees)).toBeUndefined();
  });

  it("returns undefined when cwd is outside every worktree", () => {
    const worktrees = [{ id: "/repo/wt", path: "/repo/wt" }];
    expect(inferWorktreeIdFromCwd("/home/user", worktrees)).toBeUndefined();
  });

  it("returns undefined when cwd is missing or worktrees are empty", () => {
    expect(inferWorktreeIdFromCwd(undefined, [{ id: "/a", path: "/a" }])).toBeUndefined();
    expect(inferWorktreeIdFromCwd("/a", [])).toBeUndefined();
    expect(inferWorktreeIdFromCwd("/a", undefined)).toBeUndefined();
  });

  it("matches Windows-style paths with backslash separators", () => {
    const worktrees = [{ id: "C:\\repo\\wt-a", path: "C:\\repo\\wt-a" }];
    expect(inferWorktreeIdFromCwd("C:\\repo\\wt-a\\src\\lib", worktrees)).toBe("C:\\repo\\wt-a");
  });
});

describe("buildArgsForBackendTerminal — extensionState", () => {
  it("forwards extensionState from saved data", () => {
    const extState = { tab: "overview" };
    const result = buildArgsForBackendTerminal(
      { id: "t1", kind: "terminal", title: "Shell", cwd: "/p" },
      { id: "t1", extensionState: extState },
      "/p"
    );
    expect(result.extensionState).toEqual(extState);
  });
});

describe("buildArgsForReconnectedFallback — extensionState", () => {
  it("forwards extensionState from saved data", () => {
    const extState = { scroll: 42 };
    const result = buildArgsForReconnectedFallback(
      { id: "t1", kind: "terminal", title: "Shell", cwd: "/p" },
      { id: "t1", extensionState: extState },
      "/p"
    );
    expect(result.extensionState).toEqual(extState);
  });
});

describe("buildArgsForRespawn — extensionState", () => {
  it("forwards extensionState from saved data", () => {
    const extState = { config: true };
    const result = buildArgsForRespawn(
      { id: "t1", kind: "terminal", title: "Shell", cwd: "/p", extensionState: extState },
      "terminal",
      "/p",
      undefined,
      false,
      undefined
    );
    expect(result.extensionState).toEqual(extState);
  });
});

describe("buildArgsForBackendTerminal — agent launch flags", () => {
  it("prefers backend agentLaunchFlags over saved", () => {
    const result = buildArgsForBackendTerminal(
      {
        id: "t1",
        kind: "agent",
        type: "claude",
        agentId: "claude",
        title: "Claude",
        cwd: "/p",
        agentLaunchFlags: ["--yolo"],
        agentModelId: "opus",
      },
      {
        id: "t1",
        agentLaunchFlags: ["--old-flag"],
        agentModelId: "old-model",
      },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual(["--yolo"]);
    expect(result.agentModelId).toBe("opus");
  });

  it("falls back to saved when backend has no flags", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", kind: "agent", type: "claude", agentId: "claude", title: "Claude", cwd: "/p" },
      { id: "t1", agentLaunchFlags: ["--saved-flag"], agentModelId: "saved-model" },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual(["--saved-flag"]);
    expect(result.agentModelId).toBe("saved-model");
  });

  it("falls back to saved when backend fields are null (stale JSON)", () => {
    const result = buildArgsForBackendTerminal(
      {
        id: "t1",
        kind: "agent",
        type: "claude",
        agentId: "claude",
        title: "Claude",
        cwd: "/p",
        agentLaunchFlags: null as unknown as string[] | undefined,
        agentModelId: null as unknown as string | undefined,
      },
      { id: "t1", agentLaunchFlags: ["--saved"], agentModelId: "saved" },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual(["--saved"]);
    expect(result.agentModelId).toBe("saved");
  });
});

describe("buildArgsForReconnectedFallback — agent launch flags", () => {
  it("prefers reconnected flags over saved", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", kind: "agent", title: "Claude", cwd: "/p", agentLaunchFlags: ["--new"] },
      { id: "t1", agentLaunchFlags: ["--old"] },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual(["--new"]);
  });

  it("falls back to saved when reconnected has no flags", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", kind: "agent", title: "Claude", cwd: "/p" },
      { id: "t1", agentLaunchFlags: ["--saved"], agentModelId: "saved-m" },
      "/p"
    );
    expect(result.agentLaunchFlags).toEqual(["--saved"]);
    expect(result.agentModelId).toBe("saved-m");
  });
});

// ── flavor override path ──────────────────────────────────────────────────────

describe("buildArgsForRespawn — flavor overrides", () => {
  const FLAVOR = {
    id: "user-aaa",
    name: "My Flavor",
    env: { MY_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://proxy.test" },
    customFlags: "--verbose",
    dangerousEnabled: true,
    inlineMode: false,
  };

  beforeEach(() => {
    getMergedFlavorMock.mockReset();
  });

  it("passes agentFlavorId through to result", () => {
    getMergedFlavorMock.mockReturnValue(FLAVOR);
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-aaa",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.agentFlavorId).toBe("user-aaa");
  });

  it("propagates flavor env vars into the returned env", () => {
    getMergedFlavorMock.mockReturnValue(FLAVOR);
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-aaa",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.env).toEqual(FLAVOR.env);
  });

  it("calls getMergedFlavor with the correct agentId and flavorId", () => {
    getMergedFlavorMock.mockReturnValue(FLAVOR);
    buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-aaa",
      },
      "agent",
      "/p",
      { agents: { claude: { customFlavors: [FLAVOR] } } },
      false,
      undefined
    );
    expect(getMergedFlavorMock).toHaveBeenCalledWith(
      "claude",
      "user-aaa",
      [FLAVOR],
      undefined // no CCR flavors in ccrFlavorsByAgent mock
    );
  });

  it("returns no env when the flavor has no env block", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-bbb", name: "No Env Flavor" });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-bbb",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.env).toBeUndefined();
  });

  it("falls back gracefully when the saved flavor no longer exists (stale ID)", () => {
    getMergedFlavorMock.mockReturnValue(undefined);
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-deleted",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.env).toBeUndefined();
    // command should still be generated from base settings
    expect(result.command).toBe("claude --generated");
  });

  it("does not call getMergedFlavor when agentFlavorId is absent", () => {
    buildArgsForRespawn(
      { id: "t1", kind: "agent", agentId: "claude", cwd: "/p", location: "grid" },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(getMergedFlavorMock).not.toHaveBeenCalled();
  });

  it("preserves agentFlavorId through all four buildArgs paths", () => {
    // buildArgsForBackendTerminal
    const r1 = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      { id: "t1", location: "grid", agentFlavorId: "user-aaa" },
      "/p"
    );
    expect(r1.agentFlavorId).toBe("user-aaa");

    // buildArgsForReconnectedFallback
    const r2 = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p" },
      { id: "t1", location: "grid", agentFlavorId: "user-bbb" },
      "/p"
    );
    expect(r2.agentFlavorId).toBe("user-bbb");

    // buildArgsForNonPtyRecreation
    const r3 = buildArgsForNonPtyRecreation(
      { id: "t1", kind: "browser", location: "grid", agentFlavorId: "user-ccc" },
      "browser",
      "/p"
    );
    expect(r3.agentFlavorId).toBe("user-ccc");
  });
});

// ── adversarial: behavioral overrides must reach generateAgentCommand ─────────
// These tests spy on generateAgentCommand arguments to prove that flavor
// dangerousEnabled / customFlags / inlineMode / args overrides are actually
// merged into the effectiveEntry passed to the command builder.  Previously the
// mock ignored the settings arg entirely, so a bug in the merge would be silent.

describe("adversarial: behavioral overrides flow through to generateAgentCommand", () => {
  const BASE = {
    id: "t1",
    kind: "agent" as const,
    agentId: "claude",
    cwd: "/p",
    location: "grid" as const,
    agentFlavorId: "user-x",
  };

  beforeEach(() => {
    getMergedFlavorMock.mockReset();
    generateAgentCommandMock.mockClear();
  });

  it("dangerousEnabled=true from flavor overrides base false in effectiveEntry", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "user-x",
      name: "Dangerous",
      dangerousEnabled: true,
    });
    buildArgsForRespawn(
      BASE,
      "agent",
      "/p",
      { agents: { claude: { dangerousEnabled: false } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("customFlags from flavor overrides empty base in effectiveEntry", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "user-x",
      name: "Flagged",
      customFlags: "--my-flag",
    });
    buildArgsForRespawn(
      BASE,
      "agent",
      "/p",
      { agents: { claude: { customFlags: "" } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.customFlags).toBe("--my-flag");
  });

  it("inlineMode=false from flavor overrides base true in effectiveEntry", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "NoInline", inlineMode: false });
    buildArgsForRespawn(
      BASE,
      "agent",
      "/p",
      { agents: { claude: { inlineMode: true } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.inlineMode).toBe(false);
  });

  it("flavor.dangerousEnabled=undefined does NOT clobber base true (undefined guard)", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "NoOverride" });
    buildArgsForRespawn(
      BASE,
      "agent",
      "/p",
      { agents: { claude: { dangerousEnabled: true } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
  });

  it("flavor.customFlags=undefined does NOT clobber base value (undefined guard)", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "NoFlagOverride" });
    buildArgsForRespawn(
      BASE,
      "agent",
      "/p",
      { agents: { claude: { customFlags: "--base-flag" } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.customFlags).toBe("--base-flag");
  });

  it("flavor.args are joined and passed as flavorArgs option", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "user-x",
      name: "WithArgs",
      args: ["--system-prompt", "be concise"],
    });
    buildArgsForRespawn(BASE, "agent", "/p", { agents: { claude: {} } }, false, undefined);
    const opts = generateAgentCommandMock.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.flavorArgs).toBe("--system-prompt be concise");
  });

  it("single-element flavor.args produces correct flavorArgs string", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "user-x",
      name: "OneArg",
      args: ["--output-format=json"],
    });
    buildArgsForRespawn(BASE, "agent", "/p", { agents: { claude: {} } }, false, undefined);
    const opts = generateAgentCommandMock.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.flavorArgs).toBe("--output-format=json");
  });

  it("no flavor → generateAgentCommand receives unmodified base entry", () => {
    const baseWithNoFlavor = {
      id: "t1",
      kind: "agent" as const,
      agentId: "claude",
      cwd: "/p",
      location: "grid" as const,
    };
    buildArgsForRespawn(
      baseWithNoFlavor,
      "agent",
      "/p",
      { agents: { claude: { dangerousEnabled: true, customFlags: "--base-flag" } } },
      false,
      undefined
    );
    const entry = generateAgentCommandMock.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.dangerousEnabled).toBe(true);
    expect(entry.customFlags).toBe("--base-flag");
  });

  it("flavorArgs is undefined when flavor has no args field", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "NoArgs" });
    buildArgsForRespawn(BASE, "agent", "/p", { agents: { claude: {} } }, false, undefined);
    const opts = generateAgentCommandMock.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.flavorArgs).toBeUndefined();
  });
});

// ── adversarial: agentFlavorColor must be restored on respawn ─────────────────
// Bug: buildArgsForRespawn looks up the flavor (which has a color field) but
// never writes agentFlavorColor into the returned AddTerminalArgs object.
// After an Electron reload, the dock icon loses its flavor tint and falls back
// to the vanilla brand color instead of the flavor color.

describe("adversarial: agentFlavorColor must be carried through buildArgsForRespawn", () => {
  beforeEach(() => {
    getMergedFlavorMock.mockReset();
    generateAgentCommandMock.mockClear();
  });

  it("returns agentFlavorColor from the live flavor color on respawn", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "Colored", color: "#ff6600" });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-x",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.agentFlavorColor).toBe("#ff6600");
  });

  it("returns agentFlavorColor=undefined when flavor has no color field", () => {
    getMergedFlavorMock.mockReturnValue({ id: "user-x", name: "No Color" });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-x",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.agentFlavorColor).toBeUndefined();
  });

  it("falls back to saved.agentFlavorColor when the live flavor is gone (deleted flavor)", () => {
    getMergedFlavorMock.mockReturnValue(undefined); // flavor deleted
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "user-deleted",
        agentFlavorColor: "#aabbcc",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.agentFlavorColor).toBe("#aabbcc");
  });
});

// ── adversarial: agentFlavorColor missing from non-respawn build paths ─────────
// buildArgsForRespawn was fixed to include agentFlavorColor, but three other
// builder functions (BackendTerminal, ReconnectedFallback, NonPtyRecreation)
// still forward agentFlavorId without forwarding agentFlavorColor.
// That means panels hydrated via those paths lose their color fallback.

describe("Adversarial: buildArgsForBackendTerminal preserves agentFlavorColor", () => {
  it("forwards agentFlavorColor from saved state", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      { id: "t1", location: "grid", agentFlavorId: "user-x", agentFlavorColor: "#ff6600" },
      "/p"
    );
    expect(result.agentFlavorColor).toBe("#ff6600");
  });

  it("returns undefined agentFlavorColor when saved has none", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      { id: "t1", location: "grid", agentFlavorId: "user-x" },
      "/p"
    );
    expect(result.agentFlavorColor).toBeUndefined();
  });
});

describe("Adversarial: buildArgsForReconnectedFallback preserves agentFlavorColor", () => {
  it("forwards agentFlavorColor from saved state", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      { id: "t1", location: "grid", agentFlavorId: "user-x", agentFlavorColor: "#ff6600" },
      "/p"
    );
    expect(result.agentFlavorColor).toBe("#ff6600");
  });

  it("returns undefined agentFlavorColor when saved has none", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      { id: "t1", location: "grid", agentFlavorId: "user-x" },
      "/p"
    );
    expect(result.agentFlavorColor).toBeUndefined();
  });
});

describe("Adversarial: buildArgsForNonPtyRecreation preserves agentFlavorColor", () => {
  it("forwards agentFlavorColor from saved state", () => {
    const result = buildArgsForNonPtyRecreation(
      { id: "t1", location: "grid", agentFlavorId: "user-x", agentFlavorColor: "#ff6600" },
      "agent",
      "/p"
    );
    expect(result.agentFlavorColor).toBe("#ff6600");
  });

  it("returns undefined agentFlavorColor when saved has none", () => {
    const result = buildArgsForNonPtyRecreation(
      { id: "t1", location: "grid", agentFlavorId: "user-x" },
      "agent",
      "/p"
    );
    expect(result.agentFlavorColor).toBeUndefined();
  });
});

describe("Adversarial: buildArgsForOrphanedTerminal preserves agentFlavorColor", () => {
  // OrphanedTerminal receives BackendTerminalData which has no saved state,
  // so agentFlavorColor cannot be restored — this test documents that
  // buildArgsForOrphanedTerminal does NOT have access to saved.agentFlavorColor
  // and therefore the result is always undefined (by design — no saved state available).
  it("result has no agentFlavorColor (backend-only data — no saved state available)", () => {
    const result = buildArgsForOrphanedTerminal(
      { id: "t1", cwd: "/p", kind: "agent", agentId: "claude" },
      "/p"
    );
    expect(result.agentFlavorColor).toBeUndefined();
  });
});

// ── adversarial: globalEnv merge in buildArgsForRespawn ───────────────────────
// globalEnv is a new per-agent field that applies env vars to every launch
// regardless of which flavor is active. Three invariants to verify:
//   1. Global env applies even when no flavor is active (vanilla mode)
//   2. Flavor env wins when keys overlap
//   3. Non-overlapping keys from both global and flavor survive

describe("Adversarial: globalEnv merge in buildArgsForRespawn", () => {
  it("applies globalEnv when no flavor is active (no saved agentFlavorId)", () => {
    getMergedFlavorMock.mockReturnValue(undefined);
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        // no agentFlavorId
      },
      "agent",
      "/p",
      { agents: { claude: { globalEnv: { MY_GLOBAL: "base-url" } } } },
      false,
      undefined
    );
    expect(result.env).toEqual({ MY_GLOBAL: "base-url" });
  });

  it("flavor env wins over globalEnv when keys overlap", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "f1",
      name: "Flavor",
      env: { SHARED: "flavor-wins", FLAVOR_ONLY: "f" },
    });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "f1",
      },
      "agent",
      "/p",
      { agents: { claude: { globalEnv: { SHARED: "global-loses", GLOBAL_ONLY: "g" } } } },
      false,
      undefined
    );
    expect(result.env?.SHARED).toBe("flavor-wins");
    expect(result.env?.FLAVOR_ONLY).toBe("f");
    expect(result.env?.GLOBAL_ONLY).toBe("g");
  });

  it("non-overlapping global and flavor keys both survive in the merged env", () => {
    getMergedFlavorMock.mockReturnValue({
      id: "f1",
      name: "Flavor",
      env: { FLAVOR_KEY: "fv" },
    });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "f1",
      },
      "agent",
      "/p",
      { agents: { claude: { globalEnv: { GLOBAL_KEY: "gv" } } } },
      false,
      undefined
    );
    expect(result.env).toEqual({ GLOBAL_KEY: "gv", FLAVOR_KEY: "fv" });
  });

  it("returns undefined env when globalEnv is empty and flavor has no env", () => {
    getMergedFlavorMock.mockReturnValue({ id: "f1", name: "No Env Flavor" });
    const result = buildArgsForRespawn(
      {
        id: "t1",
        kind: "agent",
        agentId: "claude",
        cwd: "/p",
        location: "grid",
        agentFlavorId: "f1",
      },
      "agent",
      "/p",
      { agents: { claude: {} } },
      false,
      undefined
    );
    expect(result.env).toBeUndefined();
  });
});
