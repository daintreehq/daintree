/**
 * Which Codex profiles the quota section reads (#13686): main's own home plus
 * every distinct `CODEX_HOME` a Codex preset sets. Pure, so the service owns
 * the store read and the filesystem check.
 */

import os from "node:os";
import path from "node:path";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import type { AgentSettingsEntry } from "../../../shared/types/agentSettings.js";
import type { CodexQuotaProfileHomeReason } from "../../../shared/types/ipc/agentQuota.js";
import { getMergedPresets } from "../../../shared/utils/agentPresets.js";

export interface CodexQuotaProfileTarget {
  /** Canonical absolute home, or the raw value when `invalid` is set. */
  home: string;
  isDefault: boolean;
  presetNames: string[];
  invalid?: CodexQuotaProfileHomeReason;
}

/** The home a Codex launch with no `CODEX_HOME` of its own runs against. */
export function defaultCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// Matched case-insensitively, as the pane-side lookup does: on Windows the
// launched process sees `codex_home` and `CODEX_HOME` as one variable.
function presetCodexHome(preset: AgentPreset): string | undefined {
  const env = preset.env;
  if (!env) return undefined;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "CODEX_HOME");
  const value = key ? env[key]?.trim() : undefined;
  return value ? value : undefined;
}

/**
 * Only presets that name their own home get a profile. A preset without one
 * runs on the default, and listing every such preset under it would bury the
 * presets that actually switch account.
 */
export function resolveCodexQuotaProfiles(
  entry: AgentSettingsEntry | undefined,
  defaultHome: string = defaultCodexHome()
): CodexQuotaProfileTarget[] {
  const targets: CodexQuotaProfileTarget[] = [
    { home: defaultHome, isDefault: true, presetNames: [] },
  ];
  const byHome = new Map<string, CodexQuotaProfileTarget>([[defaultHome, targets[0]!]]);
  const invalidByRaw = new Map<string, CodexQuotaProfileTarget>();

  for (const preset of getMergedPresets("codex", entry?.customPresets as AgentPreset[])) {
    const raw = presetCodexHome(preset);
    if (!raw) continue;
    if (!path.isAbsolute(raw)) {
      // Never resolved against main's cwd: that would read a folder no pane uses.
      const existing = invalidByRaw.get(raw);
      if (existing) {
        existing.presetNames.push(preset.name);
      } else {
        const target: CodexQuotaProfileTarget = {
          home: raw,
          isDefault: false,
          presetNames: [preset.name],
          invalid: "home-not-absolute",
        };
        invalidByRaw.set(raw, target);
        targets.push(target);
      }
      continue;
    }
    // Normalises separators, dot segments and a trailing slash, so
    // `/Users/me/.codex/` folds into the default row. Symlinks are left alone.
    const home = path.resolve(raw);
    const existing = byHome.get(home);
    if (existing) {
      existing.presetNames.push(preset.name);
      continue;
    }
    const target: CodexQuotaProfileTarget = { home, isDefault: false, presetNames: [preset.name] };
    byHome.set(home, target);
    targets.push(target);
  }

  return targets;
}
