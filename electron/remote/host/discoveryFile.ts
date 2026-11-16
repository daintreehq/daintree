import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The owner-only file next to the host socket that tells a client (through
 * `ssh <target> cat`) which socket to forward and which per-launch token to
 * present. Written atomically so a reader never sees half a file, and removed
 * on shutdown only while it still carries this launch's token. The host server
 * publishes and removes it under the socket lock (`hostSocketLock.ts`).
 */

export interface HostDiscoveryInfo {
  version: 1;
  socketPath: string;
  token: string;
  pid: number;
  /**
   * When `pid` started, as `ps -o lstart=` (macOS, whitespace collapsed) or
   * /proc field 22 (Linux) reports it: a reader tells this host from a stranger
   * that inherited the pid after a crash. Absent from older hosts and where the
   * platform can't say.
   */
  startedAt?: string;
  /**
   * The argv that runs the host's build (its executable, and its app folder
   * when unpackaged), so a Shell whose ssh server refuses socket forwarding
   * can start `<command> --attach-stdio` there instead.
   */
  command?: string[];
}

// Validated by hand rather than with zod: `--attach-stdio` reads this file, and
// that bridge loads nothing it does not need (#17022). Lengths count code
// points and integers must be safe, as zod's string and int checks do.
const TOKEN_RE = /^[0-9a-f]{64}$/;

const isBoundedString = (value: unknown, min: number, max: number): value is string => {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= min && length <= max;
};

/** Parse discovery file text; null for anything that is not a well-formed file. */
export function parseDiscoveryInfo(text: string): HostDiscoveryInfo | null {
  if (text.length > 16 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { version, socketPath, token, pid, startedAt, command } = raw as Record<string, unknown>;
  if (version !== 1) return null;
  if (!isBoundedString(socketPath, 1, 1024)) return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0) return null;
  const info: HostDiscoveryInfo = { version, socketPath, token, pid };
  if (startedAt !== undefined) {
    if (!isBoundedString(startedAt, 1, 64)) return null;
    info.startedAt = startedAt;
  }
  if (command !== undefined) {
    if (!Array.isArray(command) || command.length < 1 || command.length > 4) return null;
    if (!command.every((part) => isBoundedString(part, 1, 4096))) return null;
    info.command = [...command];
  }
  return info;
}

export async function writeDiscoveryFile(filePath: string, info: HostDiscoveryInfo): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    // "wx" refuses to follow or reuse anything already at the temp path.
    await fs.writeFile(tmp, JSON.stringify(info), { mode: 0o600, flag: "wx" });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readDiscoveryFile(filePath: string): Promise<HostDiscoveryInfo | null> {
  try {
    return parseDiscoveryInfo(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove the file only if it still advertises `token`; another launch may own
 * it now. The file is claimed by an atomic rename before it is judged, so a
 * replacement published after the first read is never the one deleted: if the
 * claimed file turns out to be someone else's, it goes back (unless a newer
 * one has been published meanwhile, which then wins).
 */
export async function removeDiscoveryFile(filePath: string, token: string): Promise<boolean> {
  const current = await readDiscoveryFile(filePath);
  if (!current || !tokensEqual(current.token, token)) return false;
  const claimed = `${filePath}.rm-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.rename(filePath, claimed);
  } catch {
    return false;
  }
  const taken = await readDiscoveryFile(claimed);
  if (taken && tokensEqual(taken.token, token)) {
    await fs.rm(claimed, { force: true }).catch(() => {});
    return true;
  }
  await fs.link(claimed, filePath).catch(() => {});
  await fs.rm(claimed, { force: true }).catch(() => {});
  return false;
}

/** Constant-time comparison; unequal lengths fail without comparing. */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
