import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const forgeClientMock = vi.hoisted(() => ({
  openIssue: vi.fn(),
  getIssueUrl: vi.fn(),
}));

const systemClientMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

const githubClientMock = vi.hoisted(() => ({
  openIssue: vi.fn(),
  openPR: vi.fn(),
  getIssueUrl: vi.fn(),
}));

const actionServiceMock = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

const mockWorktrees = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@/clients", () => ({
  forgeClient: forgeClientMock,
  systemClient: systemClientMock,
  githubClient: githubClientMock,
}));

vi.mock("@/services/ActionService", () => ({ actionService: actionServiceMock }));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: mockWorktrees }) }),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { registerWorktreeForgeActions } from "../worktreeForgeActions";

type ActionFactory = () => AnyActionDefinition;

const ACTION_IDS = [
  "worktree.openIssue",
  "worktree.openPR",
  "worktree.openPRInPortal",
  "worktree.openIssueInPortal",
] as const;

const registry = new Map<string, ActionFactory>();

function get(id: string): AnyActionDefinition {
  const factory = registry.get(id);
  if (!factory) throw new Error(`missing action: ${id}`);
  return factory();
}

const ctx = { focusedWorktreeId: "wt1", activeWorktreeId: "wt1" } as unknown as ActionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mockWorktrees.clear();
  registry.clear();
  registerWorktreeForgeActions(registry as never, {} as never);
});

describe("worktree forge actions", () => {
  it("registers all four provider-neutral actions", () => {
    for (const id of ACTION_IDS) {
      expect(registry.has(id), `missing action: ${id}`).toBe(true);
    }
  });

  it("titles and descriptions carry no GitHub wording", () => {
    for (const id of ACTION_IDS) {
      const def = get(id);
      expect(def.title).not.toMatch(/github/i);
      expect(def.description ?? "").not.toMatch(/github/i);
    }
  });

  describe("worktree.openIssue", () => {
    it("routes through forgeClient, never githubClient", async () => {
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42 });
      await get("worktree.openIssue").run?.(undefined, ctx);
      expect(forgeClientMock.openIssue).toHaveBeenCalledWith("/repo", 42);
      expect(githubClientMock.openIssue).not.toHaveBeenCalled();
    });

    it("no-ops when worktree has no issue number", async () => {
      mockWorktrees.set("wt1", { path: "/repo" });
      await get("worktree.openIssue").run?.(undefined, ctx);
      expect(forgeClientMock.openIssue).not.toHaveBeenCalled();
    });

    it("no-ops when no target worktree resolves", async () => {
      await get("worktree.openIssue").run?.(undefined, {} as ActionContext);
      expect(forgeClientMock.openIssue).not.toHaveBeenCalled();
    });
  });

  describe("worktree.openPR", () => {
    it("opens a non-GitHub PR url via systemClient.openExternal", async () => {
      const url = "https://gitlab.example.com/x/y/-/merge_requests/3";
      mockWorktrees.set("wt1", { path: "/repo", linked: { pr: { url } } });
      await get("worktree.openPR").run?.(undefined, ctx);
      expect(systemClientMock.openExternal).toHaveBeenCalledWith(url);
      expect(githubClientMock.openPR).not.toHaveBeenCalled();
    });

    it("rejects a non-http(s) PR url", async () => {
      mockWorktrees.set("wt1", {
        path: "/repo",
        linked: { pr: { url: "file:///etc/passwd" } },
      });
      await get("worktree.openPR").run?.(undefined, ctx);
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });

    it("rejects an unparseable PR url", async () => {
      mockWorktrees.set("wt1", { path: "/repo", linked: { pr: { url: "not a url" } } });
      await get("worktree.openPR").run?.(undefined, ctx);
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });

    it("no-ops when worktree has no linked PR url", async () => {
      mockWorktrees.set("wt1", { path: "/repo", linked: {} });
      await get("worktree.openPR").run?.(undefined, ctx);
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });
  });

  describe("worktree.openPRInPortal", () => {
    it("dispatches portal.openUrl with the linked PR url", async () => {
      const url = "https://gitlab.example.com/x/y/-/merge_requests/3";
      mockWorktrees.set("wt1", {
        path: "/repo",
        linked: { pr: { url, title: "Fix bug", ref: { number: 3 } } },
      });
      await get("worktree.openPRInPortal").run?.(undefined, ctx);
      expect(actionServiceMock.dispatch).toHaveBeenCalledWith(
        "portal.openUrl",
        { url, title: "Fix bug", background: false },
        { source: "user" }
      );
    });

    it("rejects a non-http(s) PR url", async () => {
      mockWorktrees.set("wt1", {
        path: "/repo",
        linked: { pr: { url: "javascript:alert(1)", ref: { number: 3 } } },
      });
      await get("worktree.openPRInPortal").run?.(undefined, ctx);
      expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it("disables when no linked PR url is present", () => {
      mockWorktrees.set("wt1", { path: "/repo", linked: {} });
      const def = get("worktree.openPRInPortal");
      expect(def.isEnabled?.(ctx)).toBe(false);
      expect(def.disabledReason?.(ctx)).toBe("Worktree has no associated PR");
    });
  });

  describe("worktree.openIssueInPortal", () => {
    it("resolves the issue url via forgeClient then dispatches portal.openUrl", async () => {
      forgeClientMock.getIssueUrl.mockResolvedValue("https://gitlab.example.com/x/y/-/issues/42");
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42, issueTitle: "Crash" });
      await get("worktree.openIssueInPortal").run?.(undefined, ctx);
      expect(forgeClientMock.getIssueUrl).toHaveBeenCalledWith("/repo", 42);
      expect(actionServiceMock.dispatch).toHaveBeenCalledWith(
        "portal.openUrl",
        {
          url: "https://gitlab.example.com/x/y/-/issues/42",
          title: "Crash",
          background: false,
        },
        { source: "user" }
      );
      expect(githubClientMock.getIssueUrl).not.toHaveBeenCalled();
    });

    it("does not dispatch when forge returns an empty url", async () => {
      forgeClientMock.getIssueUrl.mockResolvedValue("");
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42 });
      await get("worktree.openIssueInPortal").run?.(undefined, ctx);
      expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it("rejects a non-http(s) issue url returned by the forge provider", async () => {
      forgeClientMock.getIssueUrl.mockResolvedValue("javascript:alert(1)");
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42 });
      await get("worktree.openIssueInPortal").run?.(undefined, ctx);
      expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it("rejects a file: issue url returned by the forge provider", async () => {
      forgeClientMock.getIssueUrl.mockResolvedValue("file:///etc/passwd");
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42 });
      await get("worktree.openIssueInPortal").run?.(undefined, ctx);
      expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it("propagates a forgeClient.getIssueUrl rejection", async () => {
      forgeClientMock.getIssueUrl.mockRejectedValue(new Error("no provider"));
      mockWorktrees.set("wt1", { path: "/repo", issueNumber: 42 });
      await expect(get("worktree.openIssueInPortal").run?.(undefined, ctx)).rejects.toThrow(
        "no provider"
      );
      expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
    });

    it("no-ops when worktree has no issue number", async () => {
      mockWorktrees.set("wt1", { path: "/repo" });
      await get("worktree.openIssueInPortal").run?.(undefined, ctx);
      expect(forgeClientMock.getIssueUrl).not.toHaveBeenCalled();
    });
  });
});
