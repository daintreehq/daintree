import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

vi.mock("@/config/agents", () => ({
  isRegisteredAgent: (type: string) => ["claude", "gemini", "codex", "opencode"].includes(type),
  getAgentConfig: (id: string) => ({ command: id }),
}));

const buildResumeCommandMock = vi.fn(
  (agentId: string, sessionId: string, _flags?: string[]): string | undefined =>
    `${agentId} --resume ${sessionId}`
);

vi.mock("@shared/types", () => ({
  generateAgentCommand: (base: string, _settings: unknown, _id: string, _opts: unknown) =>
    `${base} --generated`,
  buildResumeCommand: (...args: unknown[]) =>
    buildResumeCommandMock(...(args as [string, string, string[]?])),
}));

const {
  inferKind,
  inferAgentIdFromTitle,
  resolveAgentId,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
} = await import("../statePatcher");

beforeEach(() => {
  buildResumeCommandMock.mockImplementation(
    (agentId: string, sessionId: string) => `${agentId} --resume ${sessionId}`
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

  it("prefers saved worktreeId over stale backend worktreeId", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "agent", title: "Claude", worktreeId: "wt-original" },
      { id: "t1", location: "grid", worktreeId: "wt-dragged" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-dragged");
  });

  it("falls back to backend worktreeId when saved worktreeId is missing", () => {
    const result = buildArgsForBackendTerminal(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell", worktreeId: "wt-backend" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-backend");
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
      worktreeId: "wt1",
    };
    const saved = { id: "t1", location: "dock", worktreeId: "wt-old", title: "Old Title" };

    const result = buildArgsForReconnectedFallback(reconnected, saved, "/fallback");
    expect(result.existingId).toBe("t1");
    expect(result.cwd).toBe("/reconnected");
    expect(result.title).toBe("Old Title");
    expect(result.worktreeId).toBe("wt-old");
    expect(result.location).toBe("dock");
  });

  it("prefers saved worktreeId over stale reconnected worktreeId", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "agent", title: "Claude", worktreeId: "wt-original" },
      { id: "t1", location: "grid", worktreeId: "wt-dragged" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-dragged");
  });

  it("falls back to reconnected worktreeId when saved worktreeId is missing", () => {
    const result = buildArgsForReconnectedFallback(
      { id: "t1", cwd: "/p", kind: "terminal", title: "Shell", worktreeId: "wt-reconnected" },
      { id: "t1", location: "grid" },
      "/p"
    );
    expect(result.worktreeId).toBe("wt-reconnected");
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
        worktreeId: "wt1",
        agentState: "idle",
        lastStateChange: 12345,
      },
      "/fallback"
    );
    expect(result.existingId).toBe("t1");
    expect(result.location).toBe("grid");
    expect(result.kind).toBe("terminal");
    expect(result.agentState).toBe("idle");
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
