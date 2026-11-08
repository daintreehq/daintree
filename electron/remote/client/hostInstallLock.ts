import crypto from "node:crypto";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandResult } from "./commandRunner.js";
import { LINUX_RUNTIME_DIR_NAME, MAC_APP_DIR_NAME } from "../host/hostSocketPath.js";
import { processStartShell } from "./hostProbe.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

/**
 * One install or update at a time on a host, whichever Shell runs it. Shells
 * don't talk to each other, so the lock lives on the host, in the ssh user's
 * own Daintree folder: a symlink `host-install.lock` naming its holder's
 * record (`owner.<token>`, its pid and when it started). The record is written
 * first and the link made with `ln -sn`, which fails while any link is there,
 * so a lock always names a complete record. The holder is a process there
 * that this install keeps running for as long as it needs the lock. It writes
 * a byte every few seconds, so it dies soon after its ssh channel goes (a
 * cancel, a crash or a dropped link here), and its exit removes the lock.
 *
 * A lock is broken only when its holder is verifiably gone: its pid no longer
 * exists, or that pid now belongs to a process started at another time (on
 * Linux, in another boot). Age never breaks one. Removing a link is always a
 * rename to a name of the remover's own first, then a look at what was moved:
 * the lock judged stale is deleted, anything else is put back. So two waiters
 * breaking the same stale lock, or one that paused for a while, never remove
 * the lock a newer holder has since taken.
 *
 * The byte comes from /bin/echo: a builtin echo that hits the closed pipe
 * keeps the byte and spills it into the next `$(...)`.
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

/** Sets `$d` to the lock's folder, `$L` to the lock and `$o` to this token's record: the same for every login as this user. */
function lockVars(token: string): string {
  return `t=${sq(token)}; if [ "$(uname -s)" = Darwin ]; then d="$HOME/Library/Application Support/${MAC_APP_DIR_NAME}"; else d="$HOME/.cache/${LINUX_RUNTIME_DIR_NAME}"; fi; L="$d/host-install.lock"; o="owner.$t"`;
}

/**
 * `ident <pid>` sets `$n` to when that process started, with Linux's boot
 * id, whose /proc start ticks repeat across boots. Empty when it can't be read.
 */
const IDENT = `ident() { ${processStartShell("1", "n")}; if [ -n "$n" ] && [ -r /proc/sys/kernel/random/boot_id ]; then n="$n@$(cat /proc/sys/kernel/random/boot_id)"; fi; }`;

/** `gone` succeeds when the lock's holder verifiably no longer runs, leaving the record it judged in `$r`. */
const GONE = `gone() { r=$(readlink "$L" 2>/dev/null); [ -n "$r" ] || return 1; p=$(sed -n 1p "$d/$r" 2>/dev/null); s=$(sed -n 2p "$d/$r" 2>/dev/null); [ -n "$p" ] || return 0; case "$p" in *[!0-9]*) return 1 ;; esac; kill -0 "$p" 2>/dev/null || return 0; [ -n "$s" ] || return 1; ident "$p"; [ -n "$n" ] && [ "$n" != "$s" ]; }`;

/** `take <record>` removes the lock only while it names that record, and puts back whatever else it moved. */
const TAKE = `take() { mv "$L" "$d/moving.$t" 2>/dev/null || return 0; m=$(readlink "$d/moving.$t" 2>/dev/null); if [ "$m" = "$1" ]; then rm -f "$d/moving.$t" "$d/$m"; else ln -sn "$m" "$L" 2>/dev/null; rm -f "$d/moving.$t"; fi; }`;

/**
 * Takes the lock and holds it until released, the channel goes or the hold's
 * cap passes, then removes it if it is still this token's. Exits at once only
 * when the lock can't be made at all.
 */
export function installLockHoldScript(token: string): string {
  return [
    `umask 077`,
    lockVars(token),
    IDENT,
    GONE,
    TAKE,
    // Only this holder makes the link name its record, so seeing it there means it is still this holder's.
    `rel() { if [ "$(readlink "$L" 2>/dev/null)" = "$o" ]; then take "$o"; fi; rm -f "$d/$o" "$d/release-$t"; }`,
    `trap rel EXIT`,
    `trap 'exit 1' HUP INT TERM PIPE`,
    `mkdir -p "$d" || exit 1`,
    `ident $$`,
    `printf '%s\\n%s\\n' "$$" "$n" > "$d/$o.tmp" && mv "$d/$o.tmp" "$d/$o" || exit 1`,
    `until ln -sn "$o" "$L" 2>/dev/null; do if gone; then take "$r"; fi; sleep 1; /bin/echo . || exit 1; done`,
    `i=0; while [ "$(readlink "$L" 2>/dev/null)" = "$o" ] && [ ! -f "$d/release-$t" ] && [ $i -lt ${HOLD_CHECKS} ]; do sleep ${HOLD_CHECK_SECONDS}; /bin/echo . || exit 1; i=$((i+1)); done`,
  ].join("; ");
}

/** What a waiter runs once it judged `record`'s holder gone: the lock goes only while it still names that record. */
export function installLockBreakScript(token: string, record: string): string {
  return `${lockVars(token)}; ${TAKE}; take ${sq(record)}`;
}

/** Whether the lock is this token's, another's, or no one's. */
export function installLockStatusScript(token: string): string {
  return `${lockVars(token)}; r=$(readlink "$L" 2>/dev/null); if [ "$r" = "$o" ]; then echo "${MARK}lock held"; elif [ -n "$r" ]; then echo "${MARK}lock other"; else echo "${MARK}lock free"; fi`;
}

/** Asks this token's holder, and only it, to let go: it removes the lock itself. */
export function installLockReleaseScript(token: string): string {
  return `${lockVars(token)}; if [ -f "$d/$o" ]; then : > "$d/release-$t"; fi`;
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

  let waiting = false;
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
    if (state === "other" && !waiting) {
      waiting = true;
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
