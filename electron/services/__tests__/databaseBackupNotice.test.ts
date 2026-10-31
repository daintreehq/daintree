import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupSuspensionNotice } from "../DatabaseMaintenanceService.js";

interface FakeWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

const { views, cachedIds, suspensionListeners } = vi.hoisted(() => ({
  views: [] as FakeWebContents[],
  cachedIds: new Set<number>(),
  suspensionListeners: [] as Array<(notice: BackupSuspensionNotice) => void>,
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: () => views,
  isCachedViewWebContents: (id: number) => cachedIds.has(id),
}));

vi.mock("../DatabaseMaintenanceService.js", () => ({
  getDatabaseMaintenanceService: () => ({
    onBackupsSuspended: (listener: (notice: BackupSuspensionNotice) => void) => {
      suspensionListeners.push(listener);
      return () => {
        suspensionListeners.splice(suspensionListeners.indexOf(listener), 1);
      };
    },
  }),
}));

import { CHANNELS } from "../../ipc/channels.js";
import {
  buildDatabaseBackupNotice,
  flushPendingDatabaseBackupNotice,
  formatBackupTime,
  installDatabaseBackupNotice,
  resetDatabaseBackupNoticeForTest,
  showDatabaseBackupNotice,
} from "../databaseBackupNotice.js";

const WRITTEN_AT = Date.UTC(2026, 9, 30, 14, 5);
const SAVED = { kind: "saved", writtenAt: WRITTEN_AT } as const;
const CORRUPTION: BackupSuspensionNotice = { reason: "corruption", backup: SAVED };
const VERIFICATION: BackupSuspensionNotice = { reason: "verification", backup: SAVED };

function view(id: number, opts: { cached?: boolean; destroyed?: boolean } = {}): FakeWebContents {
  if (opts.cached) cachedIds.add(id);
  const wc = { id, send: vi.fn(), isDestroyed: () => opts.destroyed ?? false };
  views.push(wc);
  return wc;
}

const toastsSentTo = (wc: FakeWebContents) =>
  wc.send.mock.calls
    .filter(([channel]) => channel === CHANNELS.NOTIFICATION_SHOW_TOAST)
    .map(([, payload]) => payload as { title: string });

describe("databaseBackupNotice", () => {
  beforeEach(() => {
    views.length = 0;
    cachedIds.clear();
    suspensionListeners.length = 0;
    resetDatabaseBackupNoticeForTest();
  });

  afterEach(() => {
    resetDatabaseBackupNoticeForTest();
  });

  describe("confirmed corruption", () => {
    it("names when the preserved backup was written and what relaunching will try", () => {
      const { message, duration } = buildDatabaseBackupNotice(CORRUPTION);

      expect(message).toContain(formatBackupTime(WRITTEN_AT));
      expect(message).toMatch(/relaunching will try to recover from that backup/i);
      expect(message).toMatch(/successful restore won't include changes made since/i);
      expect(message).toMatch(/if the backup can't be used, the database starts fresh/i);
      // Recovery can still fail or fall back to a fresh database.
      expect(message).not.toMatch(/will (be )?restore|has been restored|will recover/i);
      expect(duration).toBe(0);
    });

    it("promises no restore when there is no backup to restore", () => {
      const { message } = buildDatabaseBackupNotice({
        reason: "corruption",
        backup: { kind: "missing" },
      });

      expect(message).toMatch(/no earlier backup/i);
      expect(message).toMatch(/fresh/i);
      expect(message).not.toMatch(/restor|recover from that backup/i);
    });

    it("keeps the recovery wording without a time when the backup's metadata is unreadable", () => {
      const { message } = buildDatabaseBackupNotice({
        reason: "corruption",
        backup: { kind: "unreadable" },
      });

      expect(message).toMatch(/recover from that backup/i);
      expect(message).not.toMatch(/no earlier backup|\(saved/i);
    });
  });

  describe("repeated verification failures", () => {
    it.each([
      ["saved", SAVED],
      ["unreadable", { kind: "unreadable" } as const],
      ["missing", { kind: "missing" } as const],
    ])("says backups stopped with no restore or relaunch claim (%s backup)", (_label, backup) => {
      const payload = buildDatabaseBackupNotice({ reason: "verification", backup });

      expect(payload.message).toMatch(/stopped making them/i);
      expect(payload.message).not.toMatch(/restor|recover|relaunch|restart|corrupt|damage/i);
      expect(payload.title).not.toBe(buildDatabaseBackupNotice(CORRUPTION).title);
    });

    it("names when the kept backup was written", () => {
      expect(buildDatabaseBackupNotice(VERIFICATION).message).toContain(
        formatBackupTime(WRITTEN_AT)
      );
    });

    it("rate-limits apart from the corruption notice", () => {
      expect(buildDatabaseBackupNotice(VERIFICATION).rateLimitKey).not.toBe(
        buildDatabaseBackupNotice(CORRUPTION).rateLimitKey
      );
    });
  });

  describe("delivery", () => {
    it("sends one copy where the user is looking, not one per cached project view", () => {
      const active = view(1);
      const cached = view(2, { cached: true });

      showDatabaseBackupNotice(CORRUPTION);

      expect(toastsSentTo(active)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
      expect(toastsSentTo(cached)).toEqual([]);
    });

    it("falls back to a cached view when nothing else is live", () => {
      const cached = view(2, { cached: true });
      view(3, { destroyed: true });

      showDatabaseBackupNotice(CORRUPTION);

      expect(toastsSentTo(cached)).toHaveLength(1);
    });

    it("holds the notice while no window is open and delivers it once one is interactive", () => {
      showDatabaseBackupNotice(CORRUPTION);
      flushPendingDatabaseBackupNotice();

      const reopened = view(4);
      flushPendingDatabaseBackupNotice();
      flushPendingDatabaseBackupNotice();

      expect(toastsSentTo(reopened)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("keeps a held corruption notice over a later backups-stopped one", () => {
      showDatabaseBackupNotice(CORRUPTION);
      showDatabaseBackupNotice(VERIFICATION);

      const reopened = view(5);
      flushPendingDatabaseBackupNotice();

      expect(toastsSentTo(reopened)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("replaces a held backups-stopped notice with corruption", () => {
      showDatabaseBackupNotice(VERIFICATION);
      showDatabaseBackupNotice(CORRUPTION);

      const reopened = view(6);
      flushPendingDatabaseBackupNotice();

      expect(toastsSentTo(reopened)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("subscribes once however often it is installed, and delivers what the service reports", () => {
      const active = view(7);
      installDatabaseBackupNotice();
      installDatabaseBackupNotice();

      expect(suspensionListeners).toHaveLength(1);
      suspensionListeners[0](VERIFICATION);
      expect(toastsSentTo(active)).toEqual([buildDatabaseBackupNotice(VERIFICATION)]);
    });
  });
});
