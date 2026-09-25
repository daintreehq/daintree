import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyWorktreeAdminEntry, sweepWorktreeAdminEntries } from "../worktreeAdminSweep.js";

const TIMEOUT_MS = 5000;

describe("worktreeAdminSweep", () => {
  let tmp: string;
  let commonDir: string;
  let registry: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "worktree-admin-sweep-"));
    commonDir = path.join(tmp, "repo", ".git");
    registry = path.join(commonDir, "worktrees");
    mkdirSync(registry, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A registry entry whose `gitdir` names `<checkout>/.git`, as git writes it. */
  function entry(id: string, options: { checkout?: string; pointer?: string } = {}): string {
    const adminDir = path.join(registry, id);
    mkdirSync(adminDir, { recursive: true });
    const pointer =
      options.pointer ?? path.join(options.checkout ?? path.join(tmp, `gone-${id}`), ".git");
    writeFileSync(path.join(adminDir, "gitdir"), `${pointer}\n`);
    return adminDir;
  }

  function liveCheckout(name: string): string {
    const checkout = path.join(tmp, name);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, ".git"), "gitdir: somewhere\n");
    return checkout;
  }

  describe("classifyWorktreeAdminEntry", () => {
    it("is eligible when the checkout the pointer names is gone", async () => {
      const adminDir = entry("gone");
      await expect(classifyWorktreeAdminEntry(adminDir, TIMEOUT_MS)).resolves.toEqual({
        kind: "eligible",
        worktreePath: path.join(tmp, "gone-gone"),
      });
    });

    it("is ineligible while the checkout exists", async () => {
      const adminDir = entry("live", { checkout: liveCheckout("live") });
      await expect(classifyWorktreeAdminEntry(adminDir, TIMEOUT_MS)).resolves.toEqual({
        kind: "ineligible",
      });
    });

    it("is ineligible when locked, even with the checkout gone", async () => {
      const adminDir = entry("locked");
      writeFileSync(path.join(adminDir, "locked"), "on a removable drive\n");
      await expect(classifyWorktreeAdminEntry(adminDir, TIMEOUT_MS)).resolves.toEqual({
        kind: "ineligible",
      });
    });

    it("is eligible with a missing or empty gitdir file, as git prunes both", async () => {
      const missing = path.join(registry, "no-pointer");
      mkdirSync(missing);
      const empty = entry("empty-pointer", { pointer: "" });

      await expect(classifyWorktreeAdminEntry(missing, TIMEOUT_MS)).resolves.toEqual({
        kind: "eligible",
      });
      await expect(classifyWorktreeAdminEntry(empty, TIMEOUT_MS)).resolves.toEqual({
        kind: "eligible",
      });
    });

    it("resolves a relative pointer against the entry directory", async () => {
      const checkout = liveCheckout("relative-live");
      const adminDir = path.join(registry, "relative");
      mkdirSync(adminDir);
      writeFileSync(
        path.join(adminDir, "gitdir"),
        `${path.relative(adminDir, path.join(checkout, ".git"))}\n`
      );
      await expect(classifyWorktreeAdminEntry(adminDir, TIMEOUT_MS)).resolves.toEqual({
        kind: "ineligible",
      });
    });

    it("answers unknown when the pointer cannot be read, rather than guessing", async () => {
      const adminDir = path.join(registry, "unreadable");
      mkdirSync(path.join(adminDir, "gitdir"), { recursive: true });
      await expect(classifyWorktreeAdminEntry(adminDir, TIMEOUT_MS)).resolves.toMatchObject({
        kind: "unknown",
      });
    });
  });

  describe("sweepWorktreeAdminEntries", () => {
    it("removes only the phantom entries whose inventory comes back clean", async () => {
      const safe = entry("safe");
      const atRisk = entry("at-risk");
      mkdirSync(path.join(safe, "modules", "lib"), { recursive: true });
      mkdirSync(path.join(atRisk, "modules", "lib"), { recursive: true });

      const result = await sweepWorktreeAdminEntries({
        commonDir,
        timeoutMs: TIMEOUT_MS,
        assessLoss: async (adminDir) =>
          adminDir === atRisk ? "1 submodule commit that exists nowhere else" : null,
      });

      expect(result.complete).toBe(true);
      expect(result.removed).toEqual([safe]);
      expect(result.retained).toEqual([
        {
          adminDir: atRisk,
          worktreePath: path.join(tmp, "gone-at-risk"),
          loss: "1 submodule commit that exists nowhere else",
        },
      ]);
      expect(existsSync(safe)).toBe(false);
      expect(existsSync(path.join(atRisk, "modules", "lib"))).toBe(true);
    });

    it("never inventories or removes a locked or live entry", async () => {
      const locked = entry("locked");
      writeFileSync(path.join(locked, "locked"), "");
      const live = entry("live", { checkout: liveCheckout("live") });
      const assessLoss = vi.fn(async () => null);

      const result = await sweepWorktreeAdminEntries({
        commonDir,
        timeoutMs: TIMEOUT_MS,
        assessLoss,
      });

      expect(assessLoss).not.toHaveBeenCalled();
      expect(result.removed).toEqual([]);
      expect(existsSync(locked)).toBe(true);
      expect(existsSync(live)).toBe(true);
    });

    it("leaves an entry that cannot be classified and still cleans up the rest", async () => {
      const unreadable = path.join(registry, "unreadable");
      mkdirSync(path.join(unreadable, "gitdir"), { recursive: true });
      const safe = entry("safe");
      const onUnknown = vi.fn();

      const result = await sweepWorktreeAdminEntries({
        commonDir,
        timeoutMs: TIMEOUT_MS,
        assessLoss: async () => null,
        onUnknown,
      });

      expect(result.removed).toEqual([safe]);
      expect(existsSync(unreadable)).toBe(true);
      expect(onUnknown).toHaveBeenCalledWith(unreadable, expect.any(String));
    });

    it("re-checks eligibility after the inventory, so an entry locked meanwhile survives", async () => {
      // `git worktree add` locks an entry while it builds it, so a lock that
      // lands during a slow inventory is exactly what a reused id looks like.
      const adminDir = entry("reused");

      const result = await sweepWorktreeAdminEntries({
        commonDir,
        timeoutMs: TIMEOUT_MS,
        assessLoss: async () => {
          writeFileSync(path.join(adminDir, "locked"), "initializing\n");
          return null;
        },
      });

      expect(result.removed).toEqual([]);
      expect(existsSync(adminDir)).toBe(true);
    });

    it("treats an absent registry as nothing to do", async () => {
      rmSync(registry, { recursive: true });
      await expect(
        sweepWorktreeAdminEntries({
          commonDir,
          timeoutMs: TIMEOUT_MS,
          assessLoss: async () => null,
        })
      ).resolves.toEqual({ complete: true, removed: [], retained: [] });
    });

    it("reports a registry that could not be read as incomplete", async () => {
      rmSync(registry, { recursive: true });
      // A dangling symlink loop fails with ELOOP — a probe that failed, not an
      // absence.
      symlinkSync(registry, registry);
      const onUnknown = vi.fn();
      const result = await sweepWorktreeAdminEntries({
        commonDir,
        timeoutMs: TIMEOUT_MS,
        assessLoss: async () => null,
        onUnknown,
      });
      expect(result.complete).toBe(false);
      expect(onUnknown).toHaveBeenCalledWith(registry, "ELOOP");
    });
  });
});
