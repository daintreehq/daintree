// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemMemoryPressureDelivery } from "@shared/types/ipc/system";

vi.mock("@/lib/platform", () => ({ isMac: () => true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const CRITICAL: SystemMemoryPressureDelivery = {
  status: "degraded",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: "critical",
  escalated: false,
  workloads: null,
  episodeId: "episode-1",
  fileInbox: true,
};
const WARNING: SystemMemoryPressureDelivery = {
  ...CRITICAL,
  swapUsedPercent: 91,
  kernelPressureLevel: null,
};
const NORMAL: SystemMemoryPressureDelivery = {
  ...CRITICAL,
  status: "normal",
  kernelPressureLevel: null,
};

// Main's once-per-episode claims, shared by every view the test loads (#18274).
const granted = new Set<string>();
const memoryNotices = {
  claimMemoryNotice: async ({ episodeId, surface }: { episodeId: string; surface: string }) => {
    const key = `${episodeId}:${surface}`;
    if (granted.has(key)) return false;
    granted.add(key);
    return true;
  },
  releaseMemoryNotice: async ({ episodeId, surface }: { episodeId: string; surface: string }) => {
    granted.delete(`${episodeId}:${surface}`);
  },
};

// The handler's episode latches are module state, so each test loads the
// handler and the stores it writes together from a fresh module graph. A second
// load over the same localStorage is a second project view (#18274).
async function load() {
  vi.resetModules();
  const [{ handleSystemMemoryPressure }, { useNotificationStore }, history, settings, sidebar] =
    await Promise.all([
      import("../useSystemMemoryPressureNotice"),
      import("@/store/notificationStore"),
      import("@/store/slices/notificationHistorySlice"),
      import("@/store/notificationSettingsStore"),
      import("@/store/systemMemoryNoticeStore"),
    ]);
  settings.useNotificationSettingsStore.setState({
    enabled: true,
    hydrated: true,
    quietHoursEnabled: false,
  });
  const liveToasts = () =>
    useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
  const activeRows = () =>
    history.useNotificationHistoryStore.getState().entries.filter((e) => !e.archivedAt);
  return {
    handle: handleSystemMemoryPressure,
    liveToasts,
    activeRows,
    history,
    sidebarNotice: () => sidebar.useSystemMemoryNoticeStore.getState().notice,
  };
}

describe("system memory notice routing through notify()", () => {
  beforeEach(() => {
    localStorage.clear();
    granted.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(window, "electron", {
      value: {
        notification: { showNative: vi.fn(), setSessionMuteUntil: vi.fn() },
        system: memoryNotices,
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the critical toast up through later escalations of the episode (#13639)", async () => {
    const { handle, liveToasts, activeRows } = await load();

    await handle(CRITICAL);
    const [toast] = liveToasts();
    expect(toast?.title).toBe("Critical system memory pressure");

    await handle({ ...CRITICAL, swapUsedPercent: 92, escalated: true });
    await handle({ ...CRITICAL, swapUsedPercent: 92, fseventsdRssMb: 36 * 1024, escalated: true });

    expect(liveToasts().map((n) => n.id)).toEqual([toast!.id]);
    const rows = activeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("fseventsd");
  });

  it("takes the critical toast down when the escalated episode recovers", async () => {
    const { handle, liveToasts, activeRows } = await load();

    await handle(CRITICAL);
    await handle({ ...CRITICAL, swapUsedPercent: 92, escalated: true });
    await handle(NORMAL);

    expect(liveToasts().filter((n) => n.title === "Critical system memory pressure")).toEqual([]);
    expect(activeRows().map((e) => e.title)).toEqual(["System memory readings recovered"]);
  });

  it("keeps a row dismissed in one view dismissed in a view shown later in the episode (#18274)", async () => {
    const viewA = await load();
    await viewA.handle(WARNING);
    const [row] = viewA.activeRows();
    expect(row?.title).toBe("High system memory use");
    viewA.history.useNotificationHistoryStore.getState().dismissEntry(row!.id);
    viewA.history.flushNotificationHistory();

    // Main tells the next view that the row was filed, after A reported it.
    const viewB = await load();
    await viewB.handle({ ...WARNING, fileInbox: false });
    await viewB.handle({ ...WARNING, fileInbox: false, swapUsedPercent: 95, escalated: true });

    expect(viewB.activeRows()).toEqual([]);
    expect(viewB.sidebarNotice()?.reading).toContain("95%");
  });

  it("keeps a dismissed row gone when a later view replays a delivery sent before it was filed", async () => {
    const viewA = await load();
    await viewA.handle(WARNING);
    const [row] = viewA.activeRows();
    viewA.history.useNotificationHistoryStore.getState().dismissEntry(row!.id);
    viewA.history.flushNotificationHistory();

    // B's preload held a delivery that still asked it to file the row.
    const viewB = await load();
    await viewB.handle(WARNING);

    expect(viewB.activeRows()).toEqual([]);
  });

  it("toasts critical once, in the attended view, when a window behind filed the row", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const behind = await load();
    await behind.handle(CRITICAL);
    expect(behind.liveToasts()).toEqual([]);
    behind.history.flushNotificationHistory();

    vi.mocked(document.hasFocus).mockReturnValue(true);
    const attended = await load();
    await attended.handle({ ...CRITICAL, fileInbox: false });
    await attended.handle({ ...CRITICAL, fileInbox: false, swapUsedPercent: 92, escalated: true });

    expect(attended.liveToasts().map((n) => n.title)).toEqual(["Critical system memory pressure"]);
    expect(attended.activeRows().map((e) => e.id)).toEqual(behind.activeRows().map((e) => e.id));
  });

  it("raises the notice again in a later view when a new episode opens", async () => {
    const viewA = await load();
    await viewA.handle(WARNING);
    const [row] = viewA.activeRows();
    viewA.history.useNotificationHistoryStore.getState().dismissEntry(row!.id);
    viewA.history.flushNotificationHistory();

    const viewB = await load();
    await viewB.handle({ ...WARNING, fileInbox: false });
    await viewB.handle({ ...NORMAL, episodeId: "episode-1" });
    await viewB.handle({ ...WARNING, episodeId: "episode-2" });

    expect(viewB.activeRows().map((e) => e.title)).toEqual(["High system memory use"]);
  });
});
