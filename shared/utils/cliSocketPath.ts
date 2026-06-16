import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

/**
 * Single source of truth for the local control-socket path that lets the
 * `daintree-plugin` CLI drive a running Daintree instance (F32). Both the host
 * server (`electron/services/PluginCliServer.ts`) and the CLI client
 * (`packages/daintree-plugin/src/lib/socketPath.ts`) import this so the two
 * sides can never drift.
 *
 * Honors a `DAINTREE_CLI_SOCKET` override; otherwise a named pipe on Windows
 * (which doesn't live on disk) or `~/.daintree/cli.sock` everywhere else. Pure
 * node — no electron — so the CLI's tsup bundle can pull it in directly.
 */
export function getCliSocketPath(): string {
  const override = process.env.DAINTREE_CLI_SOCKET;
  if (override && override.length > 0) {
    return override;
  }
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\daintree-cli";
  }
  return path.join(os.homedir(), ".daintree", "cli.sock");
}

/**
 * Path to the control-discovery file the host writes on startup and the CLI
 * reads to learn (a) which socket/pipe to connect to and (b) the per-launch auth
 * token to present (#10518). Lives in the same `~/.daintree` directory the host
 * locks to `0700`, so on Unix it inherits that owner-only protection; on Windows
 * the user-profile NTFS ACL keeps other users out. Its absence is the canonical
 * "no Daintree instance is running" signal. `DAINTREE_CLI_CONTROL_FILE` overrides
 * it (used by tests to point at a temp file).
 */
export function getCliControlFilePath(): string {
  const override = process.env.DAINTREE_CLI_CONTROL_FILE;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".daintree", "cli-control.json");
}

/**
 * What the host advertises to the CLI: the bound socket/pipe path plus the
 * per-launch auth token the CLI must echo on every request frame. The token is
 * the actual peer-authentication gate — a same-user 0700 dir protects it on
 * Unix, and on Windows it makes the broad default named-pipe ACL unexploitable
 * (a process that can connect still can't read the token).
 */
export interface CliControlInfo {
  socketPath: string;
  token: string;
}

/**
 * Persist the control-discovery file, owner-only and atomically. Creates
 * `~/.daintree` at `0700` if missing, writes to a unique sibling temp file at
 * `0600`, then renames it into place — so a CLI racing the write never reads a
 * truncated/partial JSON file (it sees either the old complete file or the new
 * one). The mode is re-asserted on Unix before the rename in case a permissive
 * umask widened the create bits. No-op-safe to call on every `listen()`.
 */
export async function writeCliControlFile(filePath: string, info: CliControlInfo): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(tmp, 0o600).catch(() => {});
  }
  await fs.rename(tmp, filePath);
}

/**
 * Remove the control-discovery file on host shutdown, but ONLY if it still
 * belongs to this instance (its token matches). With multiple app instances the
 * last `listen()` wins the file; a different instance tearing down must not
 * delete the live file a still-running peer advertised. A no-token/absent file
 * is left untouched. Best-effort — a failed read or unlink never blocks close.
 */
export async function removeCliControlFile(filePath: string, token: string): Promise<void> {
  const current = await readCliControlFile(filePath);
  if (current && current.token === token) {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

/**
 * Read + validate the control-discovery file. Returns `null` when it's absent
 * (no instance running) or malformed, so the CLI maps either to a clean
 * "Daintree isn't running" error rather than throwing a parse error.
 */
export async function readCliControlFile(
  filePath: string = getCliControlFilePath()
): Promise<CliControlInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CliControlInfo>;
    if (typeof parsed.socketPath === "string" && typeof parsed.token === "string") {
      return { socketPath: parsed.socketPath, token: parsed.token };
    }
  } catch {
    // fall through
  }
  return null;
}
