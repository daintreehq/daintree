import path from "node:path";
import type { ShellEnvironmentObservation } from "../../setup/shellEnvironmentObservation.js";
import { resolveLaunchClaudeConfigDir } from "./claudeConfigDir.js";

const CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR";

/** What the startup probe says about the folder a pane's shell may move it to. */
export interface ClaudeUsageProfile {
  /**
   * The folder the user's login shell exports, when the probe saw it export
   * one. A pane's shell runs that profile after Daintree hands it its env, so
   * the export can replace whatever folder the pane was launched with, and
   * main never sees which it did. `null` when it exports one that can't be
   * resolved; `undefined` when it exports none, or no probe has answered.
   */
  dir: string | null | undefined;
  /** {@link dir} as the usage store keys folders; null and undefined as for `dir`. */
  identity: string | null | undefined;
  /** The shell the probe ran, as it was named; undefined with no probe. */
  shell: string | undefined;
}

export async function readClaudeUsageProfile(
  observation: ShellEnvironmentObservation | undefined,
  canonicalKey: (dir: string) => Promise<string>
): Promise<ClaudeUsageProfile> {
  const exported = observation?.env[CONFIG_DIR_VAR];
  const dir =
    exported === undefined
      ? undefined
      : (resolveLaunchClaudeConfigDir({ [CONFIG_DIR_VAR]: exported }) ?? null);
  return {
    dir,
    identity: dir ? await canonicalKey(dir) : dir,
    shell: observation?.shell,
  };
}

/**
 * The folder a pane's reading is for, or null when it can't be told. In the
 * shell the probe ran, only a pane already on the profile's folder is certain
 * to still be on it. A pane in another shell never ran that profile, so its
 * launch folder stands, as it does with no probe at all.
 */
export function placeClaudeUsageRecord(
  record: { configDir: string | null; shell: string | null },
  profile: ClaudeUsageProfile
): string | null {
  // By name, as a shell picks its startup files: `/usr/bin/bash` reads what `/bin/bash` does.
  const ranProfile =
    record.shell === null ||
    (profile.shell !== undefined && path.basename(record.shell) === path.basename(profile.shell));
  return profile.identity !== undefined && ranProfile && record.configDir !== profile.identity
    ? null
    : record.configDir;
}
