import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const forgeClientMock = vi.hoisted(() => ({
  openIssue: vi.fn(),
}));

const systemClientMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

const githubClientMock = vi.hoisted(() => ({
  openIssue: vi.fn(),
  openPR: vi.fn(),
}));

const mockWorktrees = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@/clients", () => ({
  forgeClient: forgeClientMock,
  systemClient: systemClientMock,
  githubClient: githubClientMock,
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: mockWorktrees }) }),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { registerWorktreeForgeActions } from "../worktreeForgeActions";

type ActionFactory = () => AnyActionDefinition;

const ACTION_IDS = ["worktree.openIssue", "worktree.openPR"] as const;

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
  it("registers both provider-neutral actions", () => {
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

    it("throws when worktree has no issue number", async () => {
      mockWorktrees.set("wt1", { path: "/repo" });
      await expect(get("worktree.openIssue").run?.(undefined, ctx)).rejects.toThrow(
        /Worktree has no associated issue/
      );
      expect(forgeClientMock.openIssue).not.toHaveBeenCalled();
    });

    it("throws when no target worktree resolves", async () => {
      await expect(get("worktree.openIssue").run?.(undefined, {} as ActionContext)).rejects.toThrow(
        /No active worktree/
      );
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
      await expect(get("worktree.openPR").run?.(undefined, ctx)).rejects.toThrow(
        /Pull request URL must use http/
      );
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });

    it("rejects an unparseable PR url", async () => {
      mockWorktrees.set("wt1", { path: "/repo", linked: { pr: { url: "not a url" } } });
      await expect(get("worktree.openPR").run?.(undefined, ctx)).rejects.toThrow(
        /Pull request URL is invalid/
      );
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });

    it("throws when worktree has no linked PR url", async () => {
      mockWorktrees.set("wt1", { path: "/repo", linked: {} });
      await expect(get("worktree.openPR").run?.(undefined, ctx)).rejects.toThrow(
        /Worktree has no associated pull request/
      );
      expect(systemClientMock.openExternal).not.toHaveBeenCalled();
    });
  });
});
