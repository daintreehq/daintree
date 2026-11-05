import os from "os";
import path from "path";
import { getEnvVar, hasEnvVar } from "../pty/EnvironmentFilter.js";

const CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The Claude Code config folder a process started with `env` writes to: its
 * `CLAUDE_CONFIG_DIR`, or `~/.claude` when it names none. An account launch
 * puts the account's folder there (#16040), so for an account pane this is the
 * account's store, not Daintree's own.
 *
 * Read the way the env is applied to the child, exact on POSIX and
 * case-insensitive on Windows. Undefined for an empty or relative value: what
 * the CLI makes of either is not something to guess at, and a wrong guess reads
 * some other store.
 */
export function resolveLaunchClaudeConfigDir(env: EnvLike): string | undefined {
  if (!hasEnvVar(env, CONFIG_DIR_VAR)) return path.join(os.homedir(), ".claude");
  const configDir = getEnvVar(env, CONFIG_DIR_VAR)?.trim();
  return configDir && path.isAbsolute(configDir) ? path.resolve(configDir) : undefined;
}
