import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKTREE_PORT_TIMEOUT_MS,
  WORKTREE_PORT_TIMEOUTS_MS,
  resolveWorktreePortTimeout,
} from "../worktreePortTimeouts.js";

describe("resolveWorktreePortTimeout", () => {
  it("returns the default for fast actions not in the table", () => {
    expect(resolveWorktreePortTimeout("get-all-states")).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
    expect(resolveWorktreePortTimeout("set-active")).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
    expect(resolveWorktreePortTimeout("refresh")).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
    expect(resolveWorktreePortTimeout("list-branches")).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
    expect(resolveWorktreePortTimeout("get-recent-branches")).toBe(
      DEFAULT_WORKTREE_PORT_TIMEOUT_MS
    );
    expect(resolveWorktreePortTimeout("refresh-prs")).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
    expect(resolveWorktreePortTimeout("has-resource-config")).toBe(
      DEFAULT_WORKTREE_PORT_TIMEOUT_MS
    );
    expect(resolveWorktreePortTimeout("switch-worktree-environment")).toBe(
      DEFAULT_WORKTREE_PORT_TIMEOUT_MS
    );
  });

  it("returns the table value for long-running actions", () => {
    expect(resolveWorktreePortTimeout("create-worktree")).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("delete-worktree")).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("resource-action")).toBe(10 * 60_000);
    expect(resolveWorktreePortTimeout("run-lifecycle-setup")).toBe(10 * 60_000);
  });

  it("respects an explicit positive finite override", () => {
    expect(resolveWorktreePortTimeout("create-worktree", 1234)).toBe(1234);
    expect(resolveWorktreePortTimeout("get-all-states", 5000)).toBe(5000);
  });

  it("ignores undefined override and falls back to table/default", () => {
    expect(resolveWorktreePortTimeout("create-worktree", undefined)).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("get-all-states", undefined)).toBe(
      DEFAULT_WORKTREE_PORT_TIMEOUT_MS
    );
  });

  it("rejects Infinity, NaN, zero, and negative overrides — falls back to table/default", () => {
    expect(resolveWorktreePortTimeout("create-worktree", Infinity)).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("create-worktree", -Infinity)).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("create-worktree", Number.NaN)).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("create-worktree", 0)).toBe(5 * 60_000);
    expect(resolveWorktreePortTimeout("create-worktree", -100)).toBe(5 * 60_000);

    expect(resolveWorktreePortTimeout("get-all-states", Infinity)).toBe(
      DEFAULT_WORKTREE_PORT_TIMEOUT_MS
    );
    expect(resolveWorktreePortTimeout("get-all-states", 0)).toBe(DEFAULT_WORKTREE_PORT_TIMEOUT_MS);
  });

  it("table only lists the four long-running actions", () => {
    expect(Object.keys(WORKTREE_PORT_TIMEOUTS_MS).sort()).toEqual([
      "create-worktree",
      "delete-worktree",
      "resource-action",
      "run-lifecycle-setup",
    ]);
  });
});
