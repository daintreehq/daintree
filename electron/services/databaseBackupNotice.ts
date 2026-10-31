import { CHANNELS } from "../ipc/channels.js";
import { getAllAppWebContents, isCachedViewWebContents } from "../window/webContentsRegistry.js";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import {
  getDatabaseMaintenanceService,
  type BackupFileState,
  type BackupSuspensionNotice,
} from "./DatabaseMaintenanceService.js";

/**
 * The one notice a session gets when database backups stop mid-session. Boot-
 * time recovery has its own notices (recoveryNotifications.ts); these cover
 * the time in between, when every change lands past the last recovery point.
 */
const CORRUPTION_KEY = "database-backups-suspended:corruption";
const VERIFICATION_KEY = "database-backups-suspended:verification";

let unsubscribe: (() => void) | null = null;
let pending: MainProcessToastPayload | null = null;

export function formatBackupTime(writtenAt: number): string {
  return new Date(writtenAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function corruptionMessage(backup: BackupFileState): string {
  const intact = "Your repositories and worktrees on disk aren't affected.";
  if (backup.kind === "missing") {
    return `Daintree found damage in its database and has stopped backing it up. There's no earlier backup to recover from, so relaunching will try to set the damaged database aside and start a fresh one. ${intact}`;
  }
  const saved = backup.kind === "saved" ? ` (saved ${formatBackupTime(backup.writtenAt)})` : "";
  return `Daintree found damage in its database and has stopped backing it up, to keep the last backup${saved} intact. Relaunching will try to recover from that backup. A successful restore won't include changes made since it was saved, and if the backup can't be used, the database starts fresh. ${intact}`;
}

function verificationMessage(backup: BackupFileState): string {
  const stopped =
    "New database backups kept failing their integrity check, so Daintree has stopped making them.";
  switch (backup.kind) {
    case "saved":
      return `${stopped} The existing backup, saved ${formatBackupTime(backup.writtenAt)}, is kept as it is; changes made since then aren't backed up.`;
    case "unreadable":
      return `${stopped} The existing backup is kept as it is; changes made since it was saved aren't backed up.`;
    case "missing":
      return `${stopped} No earlier backup exists, so nothing is backed up.`;
  }
}

export function buildDatabaseBackupNotice(notice: BackupSuspensionNotice): MainProcessToastPayload {
  // Persistent: the idle tick that sets these latches runs while the user is
  // away, so a timed toast would be gone before anyone saw it.
  if (notice.reason === "corruption") {
    return {
      type: "warning",
      title: "Database damage detected",
      message: corruptionMessage(notice.backup),
      duration: 0,
      rateLimitKey: CORRUPTION_KEY,
    };
  }
  return {
    type: "warning",
    title: "Database backups stopped",
    message: verificationMessage(notice.backup),
    duration: 0,
    rateLimitKey: VERIFICATION_KEY,
  };
}

/**
 * Local windows only: this is this machine's database, which a remote client
 * viewing it has no way to relaunch, and boot-time recovery is withheld from
 * remote shells for the same reason. One copy where the user is looking,
 * since cached project views would each raise their own.
 */
function deliver(payload: MainProcessToastPayload): boolean {
  const live = getAllAppWebContents().filter((wc) => !wc.isDestroyed());
  if (live.length === 0) return false;
  const visible = live.filter((wc) => !isCachedViewWebContents(wc.id));
  for (const wc of visible.length > 0 ? visible : live) {
    try {
      wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
    } catch {
      // A view torn down mid-send; the others still get it.
    }
  }
  return true;
}

export function showDatabaseBackupNotice(notice: BackupSuspensionNotice): void {
  const payload = buildDatabaseBackupNotice(notice);
  if (deliver(payload)) return;
  // macOS keeps running with every window closed. Hold the notice for the
  // next window rather than tell no one; corruption outranks a held
  // "backups stopped".
  if (pending?.rateLimitKey !== CORRUPTION_KEY) pending = payload;
}

/** Called once a renderer is interactive, so its toast listener is mounted. */
export function flushPendingDatabaseBackupNotice(): void {
  if (pending && deliver(pending)) pending = null;
}

/** Idempotent. Install before maintenance starts, so no latch fires unheard. */
export function installDatabaseBackupNotice(): void {
  if (unsubscribe) return;
  unsubscribe = getDatabaseMaintenanceService().onBackupsSuspended(showDatabaseBackupNotice);
}

/** Test-only: a fresh session. */
export function resetDatabaseBackupNoticeForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  pending = null;
}
