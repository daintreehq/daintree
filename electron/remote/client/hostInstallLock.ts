import crypto from "node:crypto";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandResult } from "./commandRunner.js";
import { LINUX_RUNTIME_DIR_NAME, MAC_APP_DIR_NAME } from "../host/hostSocketPath.js";
import { processStartShell } from "./hostProbe.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

/**
 * One install or update at a time on a host, whichever Shell runs it. Shells
 * don't talk to each other, so the lock lives on the host: a directory made
 * with `mkdir` (atomic everywhere) in the ssh user's own Daintree folder,
 * held by a process there that this install keeps running for as long as it
 * needs the lock. That process writes a byte every few seconds, so it dies
 * soon after its ssh channel goes (a cancel, a crash or a dropped link here),
 * and its exit removes the lock.
 *
 * A lock is broken only when its holder is verifiably gone: its pid no longer
 * exists, or that pid now belongs to a process started at another time (on
 * Linux, in another boot). Age decides only for a lock naming no owner yet (a
 * holder that died between creating and filling it). Breaking is done by one
 * waiter at a time, which checks again that the lock is still the one judged
 * stale before removing it, as `hostSocketLock.ts` does on the host itself.
 */

const MARK = "@@dt:";
/** How long a holder keeps the lock at most: past every timeout of an install's restart and recovery. */
const HOLD_CHECKS = 900;
const HOLD_CHECK_SECONDS = 2;
/** How long a wait for another device may last before this one gives up. */
const WAIT_TIMEOUT_MS = 12 * 60 * 60_000;
const RELEASE_WAIT_MS = (HOLD_CHECK_SECONDS + 2) * 1_000;

export interface InstallLock {
  /** Unique to this install: names its lock and its backups. */
  token: string;
  /** Whether another device held the lock first, so the host may have changed since it was looked at. */
  waited: boolean;
  /** Still held: the holder on the host is running. */
  held(): boolean;
  release(): Promise<void>;
}

export interface InstallLockDeps {
  shell: HostCommandChannel;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  pollMs?: number;
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function newInstallToken(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Sets `$L` to the lock: the same path for every login as this user. */
function lockPath(): string {
  return `if [ "$(uname -s)" = Darwin ]; then d="$HOME/Library/Application Support/${MAC_APP_DIR_NAME}"; else d="$HOME/.cache/${LINUX_RUNTIME_DIR_NAME}"; fi; L="$d/host-install.lock"`;
}

/** The lock's owner record: pid, start identity, token, one per line. */
const OWNER_TOKEN = `sed -n 3p "$L/owner" 2>/dev/null`;

/**
 * `ident <pid var>` sets `$n` to when that process started, with Linux's boot
 * id, whose /proc start ticks repeat across boots. Empty when it can't be read.
 */
const IDENT = `ident() { ${processStartShell("1", "n")}; if [ -n "$n" ] && [ -r /proc/sys/kernel/random/boot_id ]; then n="$n@$(cat /proc/sys/kernel/random/boot_id)"; fi; }`;

/** `gone` succeeds when the lock's owner verifiably no longer runs. */
const GONE = `gone() { p=$(sed -n 1p "$L/owner" 2>/dev/null); s=$(sed -n 2p "$L/owner" 2>/dev/null); if [ -z "$p" ]; then [ -n "$(find "$L" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi; case "$p" in *[!0-9]*) return 1 ;; esac; kill -0 "$p" 2>/dev/null || return 0; [ -n "$s" ] || return 1; ident "$p"; [ -n "$n" ] && [ "$n" != "$s" ]; }`;

/** `brk` removes a stale lock, one breaker at a time, only while it is still the lock judged stale. */
const BREAK = `brk() { o=$(${OWNER_TOKEN}); if mkdir "$L.break" 2>/dev/null; then if gone && [ "$(${OWNER_TOKEN})" = "$o" ]; then rm -rf "$L"; fi; rmdir "$L.break" 2>/dev/null; elif [ -n "$(find "$L.break" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$L.break" 2>/dev/null; fi; }`;

/**
 * Takes the lock and holds it until released, the channel goes or the hold's
 * cap passes, then removes it if it is still this token's. Exits at once only
 * when the lock can't be made at all.
 */
export function installLockHoldScript(token: string): string {
  const t = sq(token);
  return [
    `umask 077`,
    lockPath(),
    `t=${t}`,
    IDENT,
    GONE,
    BREAK,
    `rel() { if [ "$(${OWNER_TOKEN})" = "$t" ]; then rm -rf "$L"; fi; }`,
    `trap rel EXIT`,
    `trap 'exit 1' HUP INT TERM PIPE`,
    `mkdir -p "$d" || exit 1`,
    `until mkdir "$L" 2>/dev/null; do [ -d "$d" ] || exit 1; if gone; then brk; fi; sleep 1; echo . || exit 1; done`,
    `ident $$`,
    `printf '%s\\n%s\\n%s\\n' "$$" "$n" "$t" > "$L/owner.tmp" && mv "$L/owner.tmp" "$L/owner" || { rm -rf "$L"; exit 1; }`,
    `i=0; while [ "$(${OWNER_TOKEN})" = "$t" ] && [ ! -f "$L/release" ] && [ $i -lt ${HOLD_CHECKS} ]; do sleep ${HOLD_CHECK_SECONDS}; echo . || exit 1; i=$((i+1)); done`,
  ].join("; ");
}

/** Whether the lock is this token's, another's, or no one's. */
export function installLockStatusScript(token: string): string {
  return `${lockPath()}; o=$(${OWNER_TOKEN}); if [ "$o" = ${sq(token)} ]; then echo "${MARK}lock held"; elif [ -d "$L" ]; then echo "${MARK}lock other"; else echo "${MARK}lock free"; fi`;
}

/** Asks this token's holder to let go; only the holder removes the lock. */
export function installLockReleaseScript(token: string): string {
  return `${lockPath()}; if [ "$(${OWNER_TOKEN})" = ${sq(token)} ]; then : > "$L/release"; fi`;
}

function lockState(stdout: string): "held" | "other" | "free" | null {
  const match = new RegExp(`${MARK}lock (held|other|free)`).exec(stdout);
  return (match?.[1] as "held" | "other" | "free" | undefined) ?? null;
}

function cancelled(): AppError {
  return new AppError({ code: "CANCELLED", message: "Install cancelled" });
}

/**
 * Take the host's install lock, waiting for whichever device holds it and
 * saying so while it does. A cancel while waiting lets go of the attempt.
 */
export async function acquireInstallLock(
  deps: InstallLockDeps,
  token: string,
  signal: AbortSignal,
  onWaiting: () => void
): Promise<InstallLock> {
  if (signal.aborted) throw cancelled();
  const holder = new AbortController();
  // Set once the holder's command returns: from then on nothing holds the lock for this install.
  const run: { ended: CommandResult | null } = { ended: null };
  const hold = deps.shell
    .exec(installLockHoldScript(token), { signal: holder.signal, timeoutMs: WAIT_TIMEOUT_MS })
    .catch((err: unknown): CommandResult => ({
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : "ssh failed",
      spawnError: null,
      timedOut: false,
    }))
    .then((result) => {
      run.ended = result;
      return result;
    });
  const letGo = async () => {
    holder.abort();
    await hold;
  };

  let waited = false;
  for (;;) {
    if (signal.aborted) {
      await letGo();
      throw cancelled();
    }
    const status = await deps.shell.exec(installLockStatusScript(token), {
      signal,
      timeoutMs: 30_000,
    });
    const state = status.code === 0 ? lockState(status.stdout) : null;
    if (run.ended) {
      if (signal.aborted) throw cancelled();
      throw new AppError({
        code: "INTERNAL",
        message: `Couldn't take the host's install lock: ${failureDetail(run.ended, "ssh failed")}`,
        userMessage:
          "Couldn't make sure no other device is updating the host, so nothing was changed",
      });
    }
    if (state === "held") break;
    if (state === "other" && !waited) {
      waited = true;
      onWaiting();
    }
    try {
      await deps.sleep(deps.pollMs ?? 2_000, signal);
    } catch (err) {
      if (!signal.aborted) {
        await letGo();
        throw err;
      }
    }
  }

  let released = false;
  return {
    token,
    waited,
    held: () => run.ended === null && !released,
    async release() {
      if (released) return;
      released = true;
      if (run.ended === null) {
        await deps.shell
          .exec(installLockReleaseScript(token), { timeoutMs: 30_000 })
          .catch(() => {});
        // The holder sees the request within a check and removes the lock itself.
        await Promise.race([
          hold,
          deps.sleep(RELEASE_WAIT_MS, new AbortController().signal).catch(() => {}),
        ]);
      }
      await letGo();
    },
  };
}
