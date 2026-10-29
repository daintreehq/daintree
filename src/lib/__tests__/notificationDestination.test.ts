import { describe, expect, it } from "vitest";
import {
  hasNotificationAddress,
  isOpenableWorkspace,
  isOtherProjectContext,
  resolveNotificationDestination,
  type NotificationDestinationFacts,
} from "../notificationDestination";

const facts = (overrides: Partial<NotificationDestinationFacts> = {}) => ({
  currentProjectId: "p1",
  panelLocation: undefined,
  panelWorktreeId: undefined,
  panelWorktreeShown: true,
  worktreeLive: false,
  otherWorkspaceOpenable: false,
  ...overrides,
});

describe("resolveNotificationDestination", () => {
  it("has nowhere to go, and nothing to explain, without a panel or worktree", () => {
    expect(resolveNotificationDestination(undefined, facts())).toEqual({
      kind: "none",
      reason: null,
    });
    expect(resolveNotificationDestination({ projectId: "p1" }, facts())).toEqual({
      kind: "none",
      reason: null,
    });
  });

  it("goes to a live panel, using the worktree the panel is in now", () => {
    expect(
      resolveNotificationDestination(
        { projectId: "p1", worktreeId: "wt-old", panelId: "pane-1" },
        facts({ panelLocation: "grid", panelWorktreeId: "wt-new", worktreeLive: true })
      )
    ).toEqual({ kind: "panel", panelId: "pane-1", worktreeId: "wt-new" });
  });

  it("goes to a docked panel with no worktree", () => {
    expect(
      resolveNotificationDestination({ panelId: "pane-1" }, facts({ panelLocation: "dock" }))
    ).toEqual({ kind: "panel", panelId: "pane-1", worktreeId: undefined });
  });

  it("does not go to a panel whose worktree this view can't show", () => {
    expect(
      resolveNotificationDestination(
        { worktreeId: "wt-1", panelId: "pane-1" },
        facts({ panelLocation: "grid", panelWorktreeId: "wt-x", panelWorktreeShown: false })
      )
    ).toEqual({ kind: "none", reason: "gone" });
    expect(
      resolveNotificationDestination(
        { worktreeId: "wt-1", panelId: "pane-1" },
        facts({
          panelLocation: "grid",
          panelWorktreeId: "wt-x",
          panelWorktreeShown: false,
          worktreeLive: true,
        })
      )
    ).toEqual({ kind: "worktree", worktreeId: "wt-1" });
  });

  it("falls back to the live worktree when the panel is trashed or gone", () => {
    const context = { projectId: "p1", worktreeId: "wt-1", panelId: "pane-1" };
    expect(
      resolveNotificationDestination(context, facts({ panelLocation: "trash", worktreeLive: true }))
    ).toEqual({ kind: "worktree", worktreeId: "wt-1" });
    expect(resolveNotificationDestination(context, facts({ worktreeLive: true }))).toEqual({
      kind: "worktree",
      worktreeId: "wt-1",
    });
  });

  it("says the panel is in the trash when nothing else is left", () => {
    expect(
      resolveNotificationDestination(
        { worktreeId: "wt-1", panelId: "pane-1" },
        facts({ panelLocation: "trash" })
      )
    ).toEqual({ kind: "none", reason: "panel-trashed" });
  });

  it("never falls back to the project when the worktree is gone", () => {
    expect(
      resolveNotificationDestination({ projectId: "p1", worktreeId: "wt-gone" }, facts())
    ).toEqual({ kind: "none", reason: "gone" });
  });

  it("does not navigate a record from another project", () => {
    expect(
      resolveNotificationDestination(
        { projectId: "p2", worktreeId: "wt-1", panelId: "pane-1" },
        facts({ panelLocation: "grid", worktreeLive: true })
      )
    ).toEqual({ kind: "none", reason: "other-project" });
  });

  it("goes to another workspace on this machine, carrying the record's address", () => {
    expect(
      resolveNotificationDestination(
        { projectId: "p2", worktreeId: "wt-1", panelId: "pane-1" },
        facts({ otherWorkspaceOpenable: true })
      )
    ).toEqual({ kind: "project", projectId: "p2", panelId: "pane-1", worktreeId: "wt-1" });
    expect(
      resolveNotificationDestination(
        { projectId: "p2", worktreeId: "wt-1" },
        facts({ otherWorkspaceOpenable: true })
      )
    ).toEqual({ kind: "project", projectId: "p2", panelId: undefined, worktreeId: "wt-1" });
  });

  it("does not go to another workspace for a record that names nothing in it", () => {
    expect(
      resolveNotificationDestination({ projectId: "p2" }, facts({ otherWorkspaceOpenable: true }))
    ).toEqual({ kind: "none", reason: null });
  });

  it("never navigates a record from another machine, even when its ids match here", () => {
    expect(
      resolveNotificationDestination(
        { projectId: "p1", worktreeId: "wt-1", panelId: "pane-1", hostName: "studio-01" },
        facts({ panelLocation: "grid", worktreeLive: true })
      )
    ).toEqual({ kind: "none", reason: "other-host" });
    expect(
      resolveNotificationDestination(
        { projectId: "p2", panelId: "pane-1", hostName: "studio-01" },
        facts({ otherWorkspaceOpenable: true })
      )
    ).toEqual({ kind: "none", reason: "other-host" });
  });

  it("treats a record with no project id as this view's", () => {
    expect(
      resolveNotificationDestination({ worktreeId: "wt-1" }, facts({ worktreeLive: true }))
    ).toEqual({ kind: "worktree", worktreeId: "wt-1" });
  });
});

describe("isOpenableWorkspace", () => {
  const PROJECT = "a".repeat(64);
  const SCRATCH = "0b2d7c4e-1f3a-4b5c-8d9e-0a1b2c3d4e5f";

  it("opens a registered project unless its folder is missing", () => {
    expect(isOpenableWorkspace(PROJECT, [{ id: PROJECT, status: "closed" }], [])).toBe(true);
    expect(isOpenableWorkspace(PROJECT, [{ id: PROJECT }], [])).toBe(true);
    expect(isOpenableWorkspace(PROJECT, [{ id: PROJECT, status: "missing" }], [])).toBe(false);
    expect(isOpenableWorkspace(PROJECT, [], [])).toBe(false);
    expect(isOpenableWorkspace(undefined, [{ id: PROJECT }], [])).toBe(false);
  });

  it("opens a scratch only from the scratch list, whatever the project list holds", () => {
    expect(isOpenableWorkspace(SCRATCH, [], [{ id: SCRATCH }])).toBe(true);
    expect(isOpenableWorkspace(SCRATCH, [{ id: SCRATCH }], [])).toBe(false);
    expect(isOpenableWorkspace(PROJECT, [], [{ id: PROJECT }])).toBe(false);
  });
});

describe("notification address helpers", () => {
  it("counts only a panel or worktree as an address", () => {
    expect(hasNotificationAddress(undefined)).toBe(false);
    expect(hasNotificationAddress({ projectId: "p1" })).toBe(false);
    expect(hasNotificationAddress({ panelId: "pane-1" })).toBe(true);
    expect(hasNotificationAddress({ worktreeId: "wt-1" })).toBe(true);
  });

  it("calls a named project other unless it is the one open", () => {
    expect(isOtherProjectContext({ projectId: "p2" }, "p1")).toBe(true);
    expect(isOtherProjectContext({ projectId: "p1" }, "p1")).toBe(false);
    expect(isOtherProjectContext({}, "p1")).toBe(false);
    expect(isOtherProjectContext({}, null)).toBe(false);
    expect(isOtherProjectContext({ projectId: "p2" }, null)).toBe(true);
  });
});
