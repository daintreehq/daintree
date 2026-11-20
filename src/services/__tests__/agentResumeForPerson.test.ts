import { beforeEach, describe, expect, it, vi } from "vitest";

const { resumeSessionIntoPanel, bringResumedPaneForward, selection, spawnedIn } = vi.hoisted(
  () => ({
    resumeSessionIntoPanel: vi.fn(),
    // As the real one does: the pane's own worktree selected, the pane focused.
    bringResumedPaneForward: vi.fn(
      (resumed: { worktreeId: string | null }, show: (worktreeId: string) => void) => {
        if (resumed.worktreeId) show(resumed.worktreeId);
      }
    ),
    spawnedIn: { worktreeId: null as string | null, count: 0 },
    selection: {
      activeWorktreeId: "/repo/main" as string | null,
      selectWorktree: vi.fn((id: string) => {
        selection.activeWorktreeId = id;
      }),
    },
  })
);

vi.mock("../agentResume", () => ({ resumeSessionIntoPanel, bringResumedPaneForward }));
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
        // As the shared resume runs them when no live pane holds the session.
        options?.validateSpawn?.();
        options?.onBeforeSpawn?.();
        // The worktree on screen as the pane is added: a different one backgrounds it.
        spawnedIn.worktreeId = selection.activeWorktreeId;
        spawnedIn.count += 1;
        return { terminalId: "term-9", outcome: "created", worktreeId: target.worktreeId };
      }
    );
    spawnedIn.count = 0;
  });

  it("shows the worktree a live pane is filed under, not the record's (#18009)", async () => {
    // The conversation began in main and its pane was moved to the feature
    // worktree; the record still names main.
    let selectedByTheReveal: string | null = null;
    resumeSessionIntoPanel.mockImplementationOnce(async (_session, _target, options) => {
      // The shared resume reveals the holder before it returns.
      options?.showWorktree?.("/repo/feature");
      selectedByTheReveal = selection.activeWorktreeId;
      return {
        terminalId: "term-moved",
        outcome: "activatedExisting",
        worktreeId: "/repo/feature",
      };
    });
    const resumed = await resumeSessionForPerson(
      { ...session, worktreeId: "/repo/main", cwd: "/repo/main" },
      worktrees
    );
    expect(resumed.terminalId).toBe("term-moved");
    expect(selectedByTheReveal).toBe("/repo/feature");
    expect(selection.activeWorktreeId).toBe("/repo/feature");
    expect(bringResumedPaneForward).toHaveBeenCalledWith(resumed, expect.any(Function));
  });

  it("brings a joined resume forward in the worktree its pane is filed under", async () => {
    // Joined a resume an agent started for the same session in main, which
    // ran none of this caller's callbacks.
    resumeSessionIntoPanel.mockImplementationOnce(async () => ({
      terminalId: "term-9",
      outcome: "created",
      worktreeId: "/repo/main",
    }));
    selection.activeWorktreeId = "/repo/feature";
    await resumeSessionForPerson(session, worktrees);
    expect(bringResumedPaneForward).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "term-9", worktreeId: "/repo/main" }),
      expect.any(Function)
    );
    expect(selection.activeWorktreeId).toBe("/repo/main");
  });

  it("brings nothing forward once the person has chosen another worktree", async () => {
    resumeSessionIntoPanel.mockImplementationOnce(async () => {
      selection.activeWorktreeId = "/repo/other";
      return { terminalId: "term-9", outcome: "created", worktreeId: "/repo/feature" };
    });
    await resumeSessionForPerson(session, worktrees);
    expect(bringResumedPaneForward).not.toHaveBeenCalled();
    expect(selection.activeWorktreeId).toBe("/repo/other");
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
    expect(spawnedIn.count).toBe(0);
    expect(selection.selectWorktree).not.toHaveBeenCalled();
  });

  it("still hands back a live pane of a session whose recorded worktree is gone", async () => {
    // Moved out of the worktree before it was deleted: the pane holds the
    // conversation, so there is nothing to refuse.
    resumeSessionIntoPanel.mockImplementationOnce(async () => ({
      terminalId: "term-moved",
      outcome: "activatedExisting",
      worktreeId: "/repo/feature",
    }));
    const resumed = await resumeSessionForPerson(
      { ...session, worktreeId: "/repo/deleted" },
      worktrees
    );
    expect(resumed.terminalId).toBe("term-moved");
    expect(selection.activeWorktreeId).toBe("/repo/feature");
  });
});
