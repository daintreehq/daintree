import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupSuspensionNotice } from "../DatabaseMaintenanceService.js";

interface FakeWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  loading: boolean;
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  isLoading: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
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
  formatBackupTime,
  installDatabaseBackupNotice,
  noteDatabaseNoticeRendererReady,
  resetDatabaseBackupNoticeForTest,
  showDatabaseBackupNotice,
} from "../databaseBackupNotice.js";

const WRITTEN_AT = Date.UTC(2026, 9, 30, 14, 5);
const DAY_EARLIER = WRITTEN_AT - 24 * 60 * 60 * 1000;
const SAVED = { kind: "saved", writtenAt: WRITTEN_AT } as const;
const CORRUPTION: BackupSuspensionNotice = { reason: "corruption", backup: SAVED };
const VERIFICATION: BackupSuspensionNotice = { reason: "verification", backup: SAVED };

function view(
  id: number,
  opts: { cached?: boolean; destroyed?: boolean; ready?: boolean } = {}
): FakeWebContents {
  if (opts.cached) cachedIds.add(id);
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const wc: FakeWebContents = {
    id,
    send: vi.fn(),
    loading: false,
    isDestroyed: () => opts.destroyed ?? false,
    isCrashed: () => false,
    isLoading: () => wc.loading,
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    once: (event, listener) => wc.on(event, listener),
    removeListener: (event, listener) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener)
      ),
    emit: (event, ...args) => [...(listeners.get(event) ?? [])].forEach((l) => l(...args)),
  };
  views.push(wc);
  if (opts.ready ?? true) noteDatabaseNoticeRendererReady(id);
  return wc;
}

const DOCUMENT_NAVIGATION = { isMainFrame: true, isSameDocument: false };
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
      expect(message).not.toContain(formatBackupTime(DAY_EARLIER));
      expect(message).toMatch(/relaunching will try to recover from that backup/i);
      expect(message).toMatch(/successful restore won't include changes made since/i);
      expect(message).toMatch(/if the backup can't be used, the database starts fresh/i);
      // Recovery can still fail or fall back to a fresh database.
      expect(message).not.toMatch(/will (be )?restore|has been restored|will recover/i);
      expect(duration).toBe(0);
    });

    it("is shown through quiet hours, since every minute it waits is unrecoverable work", () => {
      expect(buildDatabaseBackupNotice(CORRUPTION).urgent).toBe(true);
      expect(buildDatabaseBackupNotice(VERIFICATION).urgent).toBeUndefined();
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
      // Raised by an idle tick while the user is away: a timed toast would be gone.
      expect(payload.duration).toBe(0);
    });

    it("names when the kept backup was written", () => {
      const { message } = buildDatabaseBackupNotice(VERIFICATION);

      expect(message).toContain(formatBackupTime(WRITTEN_AT));
      expect(message).not.toContain(formatBackupTime(DAY_EARLIER));
      expect(message).toMatch(/changes made since then aren't backed up/i);
    });

    it("says nothing is backed up when no backup exists", () => {
      const { message } = buildDatabaseBackupNotice({
        reason: "verification",
        backup: { kind: "missing" },
      });

      expect(message).toMatch(/no earlier backup exists/i);
      expect(message).not.toMatch(/existing backup/i);
    });

    it("keeps the existing backup without a time when its metadata is unreadable", () => {
      const { message } = buildDatabaseBackupNotice({
        reason: "verification",
        backup: { kind: "unreadable" },
      });

      expect(message).toMatch(/existing backup is kept/i);
      expect(message).not.toMatch(/no earlier backup|, saved /i);
    });

    it("rate-limits apart from the corruption notice", () => {
      expect(buildDatabaseBackupNotice(VERIFICATION).rateLimitKey).not.toBe(
        buildDatabaseBackupNotice(CORRUPTION).rateLimitKey
      );
    });
  });

  it("formats the backup's local date and time", () => {
    const local = new Date(2026, 9, 23, 14, 7).getTime();
    const shown = formatBackupTime(local);

    expect(shown).toContain("2026");
    expect(shown).toContain("23");
    expect(shown).toContain("07");
    expect(formatBackupTime(local - 24 * 60 * 60 * 1000)).not.toContain("23");
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

      const reopened = view(4);
      noteDatabaseNoticeRendererReady(4);

      expect(toastsSentTo(reopened)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("waits for a loading window's first-interactive instead of sending into it", () => {
      const loading = view(8, { ready: false });

      showDatabaseBackupNotice(CORRUPTION);
      expect(toastsSentTo(loading)).toEqual([]);

      noteDatabaseNoticeRendererReady(8);
      noteDatabaseNoticeRendererReady(8);
      expect(toastsSentTo(loading)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("stops sending to a renderer that reloads until it is interactive again", async () => {
      const reloading = view(14);
      reloading.emit("did-start-navigation", DOCUMENT_NAVIGATION);

      showDatabaseBackupNotice(CORRUPTION);
      reloading.emit("did-navigate");
      reloading.emit("did-stop-loading");
      await nextTurn();
      expect(toastsSentTo(reloading)).toEqual([]);

      noteDatabaseNoticeRendererReady(14);
      expect(toastsSentTo(reloading)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("trusts a renderer again once a navigation it never committed settles", async () => {
      // The app's will-navigate guard cancels a dropped file or a stray link:
      // the same document, and its listener, stay, and never report ready again.
      const page = view(18);
      page.emit("did-start-navigation", DOCUMENT_NAVIGATION);
      page.loading = true;

      showDatabaseBackupNotice(CORRUPTION);
      expect(toastsSentTo(page)).toEqual([]);

      // Still loading when the turn comes: a newer load may yet replace it.
      page.emit("did-stop-loading");
      await nextTurn();
      expect(toastsSentTo(page)).toEqual([]);

      page.loading = false;
      page.emit("did-stop-loading");
      await nextTurn();
      expect(toastsSentTo(page)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("stays ready through an in-page navigation", () => {
      const page = view(15);
      page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });

      showDatabaseBackupNotice(CORRUPTION);

      expect(toastsSentTo(page)).toHaveLength(1);
    });

    it("stops sending to a renderer whose process died", async () => {
      const crashed = view(16);
      crashed.emit("render-process-gone");
      crashed.emit("did-stop-loading");
      await nextTurn();

      showDatabaseBackupNotice(CORRUPTION);
      expect(toastsSentTo(crashed)).toEqual([]);

      noteDatabaseNoticeRendererReady(16);
      expect(toastsSentTo(crashed)).toHaveLength(1);
    });

    it("ignores a first-interactive from a sender with no local view", () => {
      showDatabaseBackupNotice(CORRUPTION);
      noteDatabaseNoticeRendererReady(19);

      // Registered later but not yet interactive: the earlier report must not count.
      const loading = view(19, { ready: false });
      showDatabaseBackupNotice(VERIFICATION);
      expect(toastsSentTo(loading)).toEqual([]);

      noteDatabaseNoticeRendererReady(19);
      expect(toastsSentTo(loading)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("keeps the notice when every send fails, for the next ready renderer", () => {
      const closing = view(9);
      closing.send.mockImplementation(() => {
        throw new Error("Render frame was disposed");
      });

      showDatabaseBackupNotice(CORRUPTION);
      const next = view(10);

      expect(toastsSentTo(next)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("counts a notice delivered when one of several recipients fails", () => {
      const closing = view(11);
      closing.send.mockImplementation(() => {
        throw new Error("Render frame was disposed");
      });
      const other = view(12);

      showDatabaseBackupNotice(CORRUPTION);
      const later = view(13);

      expect(toastsSentTo(other)).toHaveLength(1);
      expect(toastsSentTo(later)).toEqual([]);
    });

    it("keeps a held corruption notice over a later backups-stopped one", () => {
      showDatabaseBackupNotice(CORRUPTION);
      showDatabaseBackupNotice(VERIFICATION);

      const reopened = view(5);

      expect(toastsSentTo(reopened)).toEqual([buildDatabaseBackupNotice(CORRUPTION)]);
    });

    it("replaces a held backups-stopped notice with corruption", () => {
      showDatabaseBackupNotice(VERIFICATION);
      showDatabaseBackupNotice(CORRUPTION);

      const reopened = view(6);

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
