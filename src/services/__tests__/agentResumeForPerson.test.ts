import { beforeEach, describe, expect, it, vi } from "vitest";

const { resumeSessionIntoPanel, selection, spawnedIn } = vi.hoisted(() => ({
  resumeSessionIntoPanel: vi.fn(),
  spawnedIn: { worktreeId: null as string | null },
  selection: {
    activeWorktreeId: "/repo/main" as string | null,
    selectWorktree: vi.fn((id: string) => {
      selection.activeWorktreeId = id;
    }),
  },
}));

vi.mock("../agentResume", () => ({ resumeSessionIntoPanel }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject: { path: "/repo/main" } }) },
}));

import { ResumeWorktreeGoneError, resumeSessionForPerson } from "../agentResumeForPerson";

const worktrees = new Map([
  ["/repo/main", "/repo/main"],
  ["/repo/feature", "/repo/feature"],
]);

const session = {
  sessionId: "session-1",
  agentId: "claude",
  worktreeId: "/repo/feature",
  title: null,
  projectId: "p1",
  savedAt: 1,
  cwd: "/repo/feature/web",
};

describe("resumeSessionForPerson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selection.activeWorktreeId = "/repo/main";
    resumeSessionIntoPanel.mockImplementation(
      async (_session: unknown, target: { worktreeId?: string }, options) => {
        options?.onBeforeSpawn?.();
        // The worktree on screen as the pane is added: a different one backgrounds it.
        spawnedIn.worktreeId = selection.activeWorktreeId;
        return { terminalId: "term-9", outcome: "created", worktreeId: target.worktreeId };
      }
    );
  });

  it("resumes in the session's own directory, its worktree selected before the spawn", async () => {
    const resumed = await resumeSessionForPerson(session, worktrees);
    expect(resumed.terminalId).toBe("term-9");
    expect(resumeSessionIntoPanel).toHaveBeenCalledWith(
      session,
      { cwd: "/repo/feature/web", worktreeId: "/repo/feature" },
      expect.anything()
    );
    expect(selection.selectWorktree).toHaveBeenCalledWith("/repo/feature", { source: "user" });
    expect(spawnedIn.worktreeId).toBe("/repo/feature");
  });

  it("leaves a worktree chosen while the resume ran where it is", async () => {
    resumeSessionIntoPanel.mockImplementationOnce(
      async (_session: unknown, target: { worktreeId?: string }, options) => {
        options?.onBeforeSpawn?.();
        // A newer destination is chosen while the pane is still being added.
        selection.activeWorktreeId = "/repo/other";
        return { terminalId: "term-9", outcome: "created", worktreeId: target.worktreeId };
      }
    );
    await resumeSessionForPerson(session, worktrees);
    expect(selection.activeWorktreeId).toBe("/repo/other");
    expect(selection.selectWorktree).toHaveBeenCalledTimes(1);
  });

  it("brings a resume it joined into its own worktree", async () => {
    // Joined an in-flight resume: the starter's reveal never ran here.
    resumeSessionIntoPanel.mockImplementationOnce(async () => ({
      terminalId: "term-9",
      outcome: "created",
      worktreeId: "/repo/feature",
    }));
    await resumeSessionForPerson(session, worktrees);
    expect(selection.activeWorktreeId).toBe("/repo/feature");
  });

  it("trusts the session's own place where the view has no worktree list to check", async () => {
    await resumeSessionForPerson({ ...session, worktreeId: "/repo/elsewhere" }, null);
    expect(resumeSessionIntoPanel).toHaveBeenCalledWith(
      expect.anything(),
      { cwd: "/repo/feature/web", worktreeId: "/repo/elsewhere" },
      expect.anything()
    );
  });

  it("refuses a session whose worktree this view no longer has, launching nothing", async () => {
    await expect(
      resumeSessionForPerson({ ...session, worktreeId: "/repo/deleted" }, worktrees)
    ).rejects.toBeInstanceOf(ResumeWorktreeGoneError);
    expect(resumeSessionIntoPanel).not.toHaveBeenCalled();
    expect(selection.selectWorktree).not.toHaveBeenCalled();
  });
});
