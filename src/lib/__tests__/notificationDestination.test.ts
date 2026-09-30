import { describe, expect, it } from "vitest";
import {
  hasNotificationAddress,
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

  it("treats a record with no project id as this view's", () => {
    expect(
      resolveNotificationDestination({ worktreeId: "wt-1" }, facts({ worktreeLive: true }))
    ).toEqual({ kind: "worktree", worktreeId: "wt-1" });
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
