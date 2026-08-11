import { describe, it, expectTypeOf } from "vitest";
import type { IpcInvokeMap } from "../ipc/maps.js";
import type { Issue, ListOptions, Page, PR, RepoMetadata } from "../forge.js";
import type { StagingStatus } from "../git.js";
import type { KeyAction } from "../keymap.js";
import type { WorktreeConfig } from "../ipc/worktree.js";

// Helper aliases — pulled out so the assertions below stay readable.
type InvokeArgs<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["args"];
type InvokeResult<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["result"];

/**
 * Type-level contract for hand-typed IPC channels in `shared/types/ipc/maps.ts`.
 *
 * `typedHandle` already constrains handler signatures against `IpcInvokeMap[K]`,
 * but its checks are one-directional and silent against `unknown`. These
 * assertions pin each covered map entry to the exact shape callers expect, so
 * structural drift in `maps.ts` (a result widening from `string | null` to
 * `unknown`, an arg payload losing a field, a generic swap from `Page<Issue>`
 * to `Page<PR>`) trips `tsc --noEmit` instead of slipping through. Verifying
 * the handler side of the contract is tracked separately — handlers are
 * closures inside their register functions, not exported, so this file stays
 * within `shared/`.
 *
 * Coverage is intentionally representative — one or two channels per domain.
 * Generated channels (inherited via `GeneratedIpcInvokeMap`) are out of scope:
 * their map entries are produced from the same Zod schemas the runtime uses,
 * so drift can't accumulate there.
 */
describe("hand-typed IPC handler contracts", () => {
  describe("forge", () => {
    it("forge:list-issues — args + result", () => {
      expectTypeOf<InvokeArgs<"forge:list-issues">>().toEqualTypeOf<
        [payload: { cwd: string; opts?: ListOptions }]
      >();
      expectTypeOf<InvokeResult<"forge:list-issues">>().toEqualTypeOf<Page<Issue>>();
    });

    it("forge:get-pr — args + result", () => {
      expectTypeOf<InvokeArgs<"forge:get-pr">>().toEqualTypeOf<
        [payload: { cwd: string; prNumber: number }]
      >();
      expectTypeOf<InvokeResult<"forge:get-pr">>().toEqualTypeOf<PR | null>();
    });

    it("forge:get-repo-metadata — args + result", () => {
      expectTypeOf<InvokeArgs<"forge:get-repo-metadata">>().toEqualTypeOf<
        [payload: { cwd: string }]
      >();
      expectTypeOf<InvokeResult<"forge:get-repo-metadata">>().toEqualTypeOf<RepoMetadata>();
    });
  });

  describe("git", () => {
    it("git:stage-file — args + result", () => {
      expectTypeOf<InvokeArgs<"git:stage-file">>().toEqualTypeOf<
        [payload: { cwd: string; filePath: string }]
      >();
      expectTypeOf<InvokeResult<"git:stage-file">>().toEqualTypeOf<void>();
    });

    it("git:commit — args + result", () => {
      expectTypeOf<InvokeArgs<"git:commit">>().toEqualTypeOf<
        [payload: { cwd: string; message: string }]
      >();
      expectTypeOf<InvokeResult<"git:commit">>().toEqualTypeOf<{
        hash: string;
        summary: string;
      }>();
    });

    it("git:list-remote-commits — args + result", () => {
      expectTypeOf<InvokeArgs<"git:list-remote-commits">>().toEqualTypeOf<
        [payload: { cwd: string; branchName: string; limit?: number }]
      >();
      expectTypeOf<InvokeResult<"git:list-remote-commits">>().toEqualTypeOf<{
        destination: { remote: string; branch: string };
        commits: Array<{ hash: string; date: string; message: string; author: string }>;
        total: number;
      }>();
    });

    it("git:get-staging-status — args + result", () => {
      expectTypeOf<InvokeArgs<"git:get-staging-status">>().toEqualTypeOf<[cwd: string]>();
      expectTypeOf<InvokeResult<"git:get-staging-status">>().toEqualTypeOf<StagingStatus>();
    });

    it("git:get-username — args + result (nullable return guards covariant drift)", () => {
      expectTypeOf<InvokeArgs<"git:get-username">>().toEqualTypeOf<[cwd: string]>();
      expectTypeOf<InvokeResult<"git:get-username">>().toEqualTypeOf<string | null>();
    });
  });

  describe("keybinding", () => {
    it("keybinding:set-override — args + result", () => {
      expectTypeOf<InvokeArgs<"keybinding:set-override">>().toEqualTypeOf<
        [payload: { actionId: KeyAction; combo: string[] }]
      >();
      expectTypeOf<InvokeResult<"keybinding:set-override">>().toEqualTypeOf<void>();
    });

    it("keybinding:remove-override — args + result", () => {
      expectTypeOf<InvokeArgs<"keybinding:remove-override">>().toEqualTypeOf<
        [actionId: KeyAction]
      >();
      expectTypeOf<InvokeResult<"keybinding:remove-override">>().toEqualTypeOf<void>();
    });
  });

  describe("worktree-config", () => {
    it("worktree-config:set-pattern — args + result", () => {
      expectTypeOf<InvokeArgs<"worktree-config:set-pattern">>().toEqualTypeOf<
        [payload: { pattern: string }]
      >();
      expectTypeOf<InvokeResult<"worktree-config:set-pattern">>().toEqualTypeOf<WorktreeConfig>();
    });

    it("worktree-config:set-wsl-git — args + result", () => {
      expectTypeOf<InvokeArgs<"worktree-config:set-wsl-git">>().toEqualTypeOf<
        [payload: { worktreeId: string; enabled: boolean }]
      >();
      expectTypeOf<InvokeResult<"worktree-config:set-wsl-git">>().toEqualTypeOf<void>();
    });
  });

  /**
   * Zero-arg channels with non-trivial result shapes. Sibling write channels
   * in these domains (`privacy:set-telemetry-level`, `privacy:set-log-retention`,
   * `shortcut-hints:increment-count`) still declare `unknown` parameters and
   * validate at runtime; tightening those is tracked separately by #8578.
   * Asserting `[]` for the GETs is cheap and forces a maintainer who adds an
   * arg to update the test instead of the assertion drifting silently.
   */
  describe("zero-arg getters with non-trivial result shapes", () => {
    it("privacy:get-settings — args + result", () => {
      expectTypeOf<InvokeArgs<"privacy:get-settings">>().toEqualTypeOf<[]>();
      expectTypeOf<InvokeResult<"privacy:get-settings">>().toEqualTypeOf<{
        telemetryLevel: "off" | "errors" | "full";
        logRetentionDays: 0 | 7 | 30 | 90;
        dataFolderPath: string;
      }>();
    });

    it("sentry:get-consent-state — args + result", () => {
      expectTypeOf<InvokeArgs<"sentry:get-consent-state">>().toEqualTypeOf<[]>();
      expectTypeOf<InvokeResult<"sentry:get-consent-state">>().toEqualTypeOf<{
        level: "off" | "errors" | "full";
        hasSeenPrompt: boolean;
      }>();
    });

    it("shortcut-hints:get-counts — args + result", () => {
      expectTypeOf<InvokeArgs<"shortcut-hints:get-counts">>().toEqualTypeOf<[]>();
      expectTypeOf<InvokeResult<"shortcut-hints:get-counts">>().toEqualTypeOf<
        Record<string, number>
      >();
    });
  });
});
