// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";

vi.mock("@/lib/platform", () => ({ isMac: () => true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const CRITICAL: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: "critical",
  escalated: false,
  workloads: null,
};
const NORMAL: SystemMemoryPressurePayload = {
  ...CRITICAL,
  status: "normal",
  kernelPressureLevel: null,
};

// The handler's episode latches are module state, so each test loads the
// handler and the stores it writes together from a fresh module graph.
async function load() {
  vi.resetModules();
  const [{ handleSystemMemoryPressure }, { useNotificationStore }, history, settings] =
    await Promise.all([
      import("../useSystemMemoryPressureNotice"),
      import("@/store/notificationStore"),
      import("@/store/slices/notificationHistorySlice"),
      import("@/store/notificationSettingsStore"),
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
  return { handle: handleSystemMemoryPressure, liveToasts, activeRows };
}

describe("system memory notice routing through notify()", () => {
  beforeEach(() => {
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
});
