/**
 * Which Codex profiles the quota section reads (#13686): the home a preset-free
 * launch uses plus every distinct `CODEX_HOME` a Codex preset sets. Pure, so
 * the service owns the store read and the filesystem check.
 */

import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import type { AgentSettingsEntry } from "../../../shared/types/agentSettings.js";
import type { CodexQuotaProfileHomeReason } from "../../../shared/types/ipc/agentQuota.js";
import { getMergedPresets, sanitizeAgentEnv } from "../../../shared/utils/agentPresets.js";

export interface CodexQuotaProfileTarget {
  /** Canonical absolute home, or the raw value when `invalid` is set. */
  home: string;
  isDefault: boolean;
  presetNames: string[];
  /** Each name's position in the preset list, so a later merge can keep preset order. */
  presetOrder: number[];
  invalid?: CodexQuotaProfileHomeReason;
  /**
   * Main's own home, read by inheriting main's env rather than naming it, and
   * the one home read without checking it exists first: Codex doesn't need
   * its implicit home to exist, only one it's handed.
   */
  inheritsMainEnv?: boolean;
}

/** Main's own home: where a Codex launch lands when nothing in its env names one. */
export function defaultCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// Matched case-insensitively, as the pane-side lookup does: on Windows the
// launched process sees `codex_home` and `CODEX_HOME` as one variable.
function envCodexHome(env: Record<string, string> | undefined): string | undefined {
  if (!env) return undefined;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "CODEX_HOME");
  // Untrimmed: the pane gets the value verbatim, so `/Users/me/.codex ` is a
  // different folder from the default, not a spelling of it.
  return key && env[key] ? env[key] : undefined;
}

/**
 * Windows' `path.isAbsolute` also accepts `\profiles\work`, which lands on
 * whichever drive the process happens to be on: main's and a pane's can differ.
 */
function isFullyQualified(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

// Windows paths are case-insensitive, so two spellings of one home share a row.
function homeIdentity(home: string): string {
  return process.platform === "win32" ? home.toLowerCase() : home;
}

/**
 * The key one directory has however it's spelled (#13702). The promise
 * `realpath` resolves symlinks and returns the on-disk case on a
 * case-insensitive volume; the callback and sync forms keep the typed case.
 * A home it can't resolve keeps the spelling-only key, as Codex's own store
 * key falls back to the raw path.
 */
export async function canonicalCodexHomeKey(home: string): Promise<string> {
  try {
    return homeIdentity(await realpath(home));
  } catch {
    return homeIdentity(home);
  }
}

/**
 * The home a launch with no preset home runs on (#15047). The agent-wide env
 * sits under every preset's and over main's, so a `CODEX_HOME` there moves
 * every such pane; it's sanitized the way the launch sanitizes it, so a value
 * the launch drops falls through to main's here too.
 */
export function resolveDefaultCodexTarget(
  entry: AgentSettingsEntry | undefined,
  mainHome: string = defaultCodexHome()
): CodexQuotaProfileTarget {
  const base: Omit<CodexQuotaProfileTarget, "home"> = {
    isDefault: true,
    presetNames: [],
    presetOrder: [],
  };
  const raw = envCodexHome(sanitizeAgentEnv(entry?.globalEnv as Record<string, unknown>));
  if (!raw) return { ...base, home: mainHome, inheritsMainEnv: true };
  if (!isFullyQualified(raw)) return { ...base, home: raw, invalid: "home-not-absolute" };
  return { ...base, home: path.resolve(raw) };
}

/**
 * Only presets that name their own home get a profile. A preset without one
 * runs on the default, and listing every such preset under it would bury the
 * presets that actually switch account.
 */
export function resolveCodexQuotaProfiles(
  entry: AgentSettingsEntry | undefined,
  mainHome: string = defaultCodexHome()
): CodexQuotaProfileTarget[] {
  const defaultTarget = resolveDefaultCodexTarget(entry, mainHome);
  const targets: CodexQuotaProfileTarget[] = [defaultTarget];
  const byHome = new Map<string, CodexQuotaProfileTarget>();
  const invalidByRaw = new Map<string, CodexQuotaProfileTarget>();
  if (defaultTarget.invalid) invalidByRaw.set(defaultTarget.home, defaultTarget);
  else byHome.set(homeIdentity(defaultTarget.home), defaultTarget);

  for (const [order, preset] of getMergedPresets(
    "codex",
    entry?.customPresets as AgentPreset[]
  ).entries()) {
    const raw = envCodexHome(preset.env);
    if (!raw) continue;
    if (!isFullyQualified(raw)) {
      // Never resolved against main's cwd: that would read a folder no pane uses.
      const existing = invalidByRaw.get(raw);
      if (existing) {
        existing.presetNames.push(preset.name);
        existing.presetOrder.push(order);
      } else {
        const target: CodexQuotaProfileTarget = {
          home: raw,
          isDefault: false,
          presetNames: [preset.name],
          presetOrder: [order],
          invalid: "home-not-absolute",
        };
        invalidByRaw.set(raw, target);
        targets.push(target);
      }
      continue;
    }
    // Normalises separators, dot segments and a trailing slash, so
    // `/Users/me/.codex/` folds into the default row. Symlinks and case on a
    // case-insensitive volume are folded later, by the service's realpath.
    const home = path.resolve(raw);
    const existing = byHome.get(homeIdentity(home));
    if (existing) {
      existing.presetNames.push(preset.name);
      existing.presetOrder.push(order);
      continue;
    }
    const target: CodexQuotaProfileTarget = {
      home,
      isDefault: false,
      presetNames: [preset.name],
      presetOrder: [order],
    };
    byHome.set(homeIdentity(home), target);
    targets.push(target);
  }

  return targets;
}
