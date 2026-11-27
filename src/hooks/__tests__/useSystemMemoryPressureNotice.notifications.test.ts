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
  launchNoticeShown: false,
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
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(window, "electron", {
      value: { notification: { showNative: vi.fn(), setSessionMuteUntil: vi.fn() } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the critical toast up through later escalations of the episode (#13639)", async () => {
    const { handle, liveToasts, activeRows } = await load();

    handle(CRITICAL);
    const [toast] = liveToasts();
    expect(toast?.title).toBe("Critical system memory pressure");

    handle({ ...CRITICAL, swapUsedPercent: 92, escalated: true });
    handle({ ...CRITICAL, swapUsedPercent: 92, fseventsdRssMb: 36 * 1024, escalated: true });

    expect(liveToasts().map((n) => n.id)).toEqual([toast!.id]);
    const rows = activeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("fseventsd");
  });

  it("takes the critical toast down when the escalated episode recovers", async () => {
    const { handle, liveToasts, activeRows } = await load();

    handle(CRITICAL);
    handle({ ...CRITICAL, swapUsedPercent: 92, escalated: true });
    handle(NORMAL);

    expect(liveToasts().filter((n) => n.title === "Critical system memory pressure")).toEqual([]);
    expect(activeRows().map((e) => e.title)).toEqual(["System memory readings recovered"]);
  });

  it("keeps a row dismissed in one view dismissed in a view shown later in the episode (#18274)", async () => {
    const viewA = await load();
    viewA.handle(WARNING);
    const [row] = viewA.activeRows();
    expect(row?.title).toBe("High system memory use");
    viewA.history.useNotificationHistoryStore.getState().dismissEntry(row!.id);
    viewA.history.flushNotificationHistory();

    // Main tells the next view that the row was filed, after A reported it.
    const viewB = await load();
    viewB.handle({ ...WARNING, fileInbox: false });
    viewB.handle({ ...WARNING, fileInbox: false, swapUsedPercent: 95, escalated: true });

    expect(viewB.activeRows()).toEqual([]);
    expect(viewB.sidebarNotice()?.reading).toContain("95%");
  });

  it("files one shared row when two views are asked together", async () => {
    const viewA = await load();
    viewA.handle(WARNING);
    viewA.history.flushNotificationHistory();

    const viewB = await load();
    viewB.handle(WARNING);

    expect(viewB.activeRows().map((e) => e.id)).toEqual(viewA.activeRows().map((e) => e.id));
  });

  it("raises the notice again in a later view when a new episode opens", async () => {
    const viewA = await load();
    viewA.handle(WARNING);
    const [row] = viewA.activeRows();
    viewA.history.useNotificationHistoryStore.getState().dismissEntry(row!.id);
    viewA.history.flushNotificationHistory();

    const viewB = await load();
    viewB.handle({ ...WARNING, fileInbox: false });
    viewB.handle({ ...NORMAL, episodeId: "episode-1" });
    viewB.handle({ ...WARNING, episodeId: "episode-2" });

    expect(viewB.activeRows().map((e) => e.title)).toEqual(["High system memory use"]);
  });
});
