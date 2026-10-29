import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";
import type { HelpPastSessionsListing } from "../../../../shared/types/ipc/help.js";

const LISTING: HelpPastSessionsListing = {
  sessions: [{ agentId: "codex", sessionId: "t1", title: "Earlier question", updatedAt: 1 }],
  unreadable: ["claude"],
  truncated: true,
};

const lister = vi.hoisted(() => ({
  listHelpPastSessions: vi.fn(),
  defaultClaudeProjectsRoot: () => "/home/.claude/projects",
}));
vi.mock("../../../services/helpPastSessions.js", () => lister);
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getSessionPathForProject: (projectPath: string, agentId: string) =>
      agentId === "claude" ? `${projectPath}/h` : `${projectPath}/h.${agentId}`,
    getLegacySessionPathForProject: (projectPath: string) => `${projectPath}/h`,
  },
}));
vi.mock("../../../services/claude/ClaudeSessionStore.js", () => ({
  resolvePaneClaudeProjectsRoot: () => null,
}));
vi.mock("../../../services/codex/CodexSubagentService.js", () => ({
  listCodexSessionsForCwd: vi.fn(),
}));
// Both projects are real, so only the guard stands between a view and the other's history.
vi.mock("../../../services/ProjectStore.js", () => {
  const projects = new Map([
    ["p1", { path: "/repo" }],
    ["p2", { path: "/other" }],
  ]);
  return { projectStore: { getProjectById: (id: string) => projects.get(id) } };
});
vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: { getScratchById: () => undefined },
}));

const { handleListPastSessions } = await import("../help.js");

// The guard reads only these two; the refusal must come before anything else is touched.
const viewOf = (projectId: string | null): IpcContext => ({ projectId, webContentsId: 7 }) as never;

describe("handleListPastSessions (#14984)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    lister.listHelpPastSessions.mockReset();
  });

  it("refuses another project's history as no history at all, in either answer shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    lister.listHelpPastSessions.mockResolvedValue(LISTING);
    await expect(handleListPastSessions(viewOf("p1"), "p2")).resolves.toEqual([]);
    await expect(handleListPastSessions(viewOf("p1"), "p2", { listing: true })).resolves.toEqual({
      sessions: [],
      unreadable: [],
      truncated: false,
    });
    expect(lister.listHelpPastSessions).not.toHaveBeenCalled();
  });

  it("answers its own project with bare rows by default, and the listing when asked", async () => {
    lister.listHelpPastSessions.mockResolvedValue(LISTING);

    await expect(handleListPastSessions(viewOf("p1"), "p1")).resolves.toEqual(LISTING.sessions);
    await expect(handleListPastSessions(viewOf("p1"), "p1", { listing: true })).resolves.toEqual(
      LISTING
    );
    // Paths come from main's record of the project, never the renderer.
    expect(lister.listHelpPastSessions).toHaveBeenCalledWith(
      { claude: "/repo/h", codex: ["/repo/h.codex", "/repo/h"] },
      expect.objectContaining({ claudeProjectsRoot: "/home/.claude/projects" })
    );
  });

  it("answers an unbound view the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handleListPastSessions(viewOf(null), "p1", { listing: true })).resolves.toEqual({
      sessions: [],
      unreadable: [],
      truncated: false,
    });
  });
});
