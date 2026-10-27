// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReEntrySummary } from "../useReEntrySummary";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { usePanelStore } from "@/store/panelStore";
import type { Project } from "@shared/types";
import type { Scratch } from "@shared/types/scratch";
import type { BrowserPanelData } from "@shared/types/panel";
import { APP_SOURCE_LABEL } from "@/lib/notificationSourceLabel";
import { __resetPowerPolicyStateForTests, isScreenLocked } from "@/lib/powerPolicyState";
import type { PowerPolicySnapshot } from "@shared/types/powerPolicy";

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: vi.fn(),
}));

vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: vi.fn(() => "proj-here"),
}));

// The return check runs a frame after focus or unlock. Frames run inline here,
// so each test reads the summary straight after the event that ends the
// absence; the deferral itself has its own test with a queued frame.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function addEntry(
  overrides: Partial<{
    type: "success" | "error" | "info" | "warning";
    message: string;
    title: string;
    seenAsToast: boolean;
    context: { worktreeId?: string; projectId?: string; hostName?: string; panelId?: string };
  }> = {}
) {
  useNotificationHistoryStore.getState().addEntry({
    type: overrides.type ?? "success",
    message: overrides.message ?? "Test",
    title: overrides.title,
    seenAsToast: overrides.seenAsToast,
    ...(overrides.context ? { context: overrides.context } : {}),
  });
}

function project(id: string, name: string): Project {
  return { id, name, path: `/work/${name}`, emoji: "", lastOpened: 0 };
}

function scratch(id: string, name: string): Scratch {
  return { id, name, path: `/scratches/${id}`, createdAt: 0, lastOpened: 0 };
}

function panel(id: string): BrowserPanelData {
  return { id, kind: "browser", title: id, location: "grid" };
}

function focusAfter(ms: number) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  Date.now = realNow;
}

function simulateBlurFocusCycle(blurDurationMs: number) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;

  act(() => {
    window.dispatchEvent(new Event("blur"));
  });

  now += blurDurationMs;

  act(() => {
    window.dispatchEvent(new Event("focus"));
  });

  Date.now = realNow;
}

describe("useReEntrySummary", () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useProjectStore.setState({ projects: [], currentProject: null });
    useScratchStore.setState({ scratches: [] });
    usePanelStore.setState({ panelsById: {} });
    vi.mocked(getViewWorkspaceId).mockReturnValue("proj-here");
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue(null);
  });

  afterEach(() => {
    hasFocusSpy.mockRestore();
  });

  it("shows summary on focus after 3+ seconds blur with unseen entries", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    addEntry({
      type: "error",
      message: "Build failed",
      context: { worktreeId: "wt-1" },
    });
    addEntry({
      type: "success",
      message: "Agent done",
      context: { worktreeId: "wt-2" },
    });

    const realNow = Date.now;
    const later = realNow() + 5000;
    Date.now = () => later;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0]!.highlight.type).toBe("error");
    expect(result.current.rows[1]!.highlight.type).toBe("success");
  });

  it("does not show summary when blur is less than 3 seconds", () => {
    const { result } = renderHook(() => useReEntrySummary());

    simulateBlurFocusCycle(1000);

    expect(result.current.visible).toBe(false);
  });

  it("does not show summary when no unseen entries exist", () => {
    const { result } = renderHook(() => useReEntrySummary());

    addEntry({
      type: "success",
      message: "Seen",
      seenAsToast: true,
      context: { worktreeId: "wt-1" },
    });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("excludes already-summarized entries on subsequent focus", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "First batch",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);

    act(() => {
      result.current.dismiss();
    });

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    now += 5000;
    addEntry({
      type: "error",
      message: "Second batch",
      context: { worktreeId: "wt-1" },
    });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.message).toBe("Second batch");
  });

  it("does not trigger when document.hasFocus() returns false", () => {
    hasFocusSpy.mockReturnValue(false);
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Test",
      context: { worktreeId: "wt-1" },
    });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("dismiss hides the summary", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Test",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.visible).toBe(false);
  });

  it("groups entries by worktreeId and picks worst severity and highlight title", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "info",
      message: "Info message",
      title: "Info Title",
      context: { worktreeId: "wt-1" },
    });
    addEntry({
      type: "error",
      message: "Error message",
      title: "Error Title",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]!.key).toBe("worktree:wt-1");
    expect(result.current.rows[0]!.highlight.type).toBe("error");
    expect(result.current.rows[0]!.highlightTitle).toBe("Error Title");
    expect(result.current.rows[0]!.entryCount).toBe(2);
  });

  it("falls back to message when title is undefined", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "warning",
      message: "Warning fallback",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.highlightTitle).toBe("Warning fallback");
  });

  it("sorts rows by severity, then entry count, then worktree name", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "info",
      message: "A",
      context: { worktreeId: "wt-info" },
    });
    addEntry({
      type: "error",
      message: "B",
      context: { worktreeId: "wt-error" },
    });
    addEntry({
      type: "warning",
      message: "C",
      context: { worktreeId: "wt-warn" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.highlight.type).toBe("error");
    expect(result.current.rows[1]!.highlight.type).toBe("warning");
    expect(result.current.rows[2]!.highlight.type).toBe("info");
  });

  it("caps rows at 3 and sets overflowCount", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    for (let i = 0; i < 5; i++) {
      addEntry({
        type: "info",
        message: `Entry ${i}`,
        context: { worktreeId: `wt-${i}` },
      });
    }

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows).toHaveLength(3);
    expect(result.current.overflowCount).toBe(2);
    // The overflow is part of the summary ("+2 more"), so its entries are marked too.
    expect(result.current.entries).toHaveLength(5);
    expect(useNotificationHistoryStore.getState().entries.every((e) => e.summarized)).toBe(true);
  });

  it("resolves worktree name from current view store", async () => {
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
      getState: () => ({
        worktrees: new Map([
          [
            "wt-1",
            {
              id: "wt-1",
              path: "/tmp/wt-1",
              name: "feature-xyz",
              isCurrent: false,
              worktreeId: "wt-1",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);

    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Done",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.label).toBe("feature-xyz");
  });

  it("names an unresolved worktree by the last segment of its path, not a prefix of it", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Done",
      context: { worktreeId: "/Users/dev/Projects/atlas-api-worktrees/feature-rate-limits" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    // A worktree id is its path: its first twelve characters are the user's
    // home directory, the same for every worktree; its last segment is which.
    expect(result.current.rows[0]!.label).toBe("feature-rate-limits");
  });

  it("falls back to the path's last segment when the worktree name is empty", async () => {
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
      getState: () => ({
        worktrees: new Map([
          [
            "/tmp/work/wt-one",
            {
              id: "/tmp/work/wt-one",
              path: "/tmp/work/wt-one",
              name: "",
              isCurrent: false,
              worktreeId: "/tmp/work/wt-one",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);

    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "Done", context: { worktreeId: "/tmp/work/wt-one" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.label).toBe("wt-one");
  });

  it("sorts by name as tiebreaker when severity and count are equal", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Z", context: { worktreeId: "wt-zeta" } });
    addEntry({ type: "info", message: "A", context: { worktreeId: "wt-alpha" } });
    addEntry({ type: "info", message: "B", context: { worktreeId: "wt-beta" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.key).toBe("worktree:wt-alpha");
    expect(result.current.rows[1]!.key).toBe("worktree:wt-beta");
    expect(result.current.rows[2]!.key).toBe("worktree:wt-zeta");
  });

  it("gives entries with no worktree a row for their project", () => {
    useProjectStore.setState({
      projects: [project("proj-decoy", "decoy"), project("proj-here", "atlas-api")],
      currentProject: project("proj-here", "atlas-api"),
    });
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "warning",
      message: "Recipes failed to load",
      context: { projectId: "proj-here" },
    });
    addEntry({
      type: "success",
      message: "Done",
      context: { worktreeId: "wt-1", projectId: "proj-here" },
    });

    focusAfter(5000);

    expect(result.current.visible).toBe(true);
    expect(result.current.rows.map((r) => r.label)).toEqual(["atlas-api", "wt-1"]);
    expect(result.current.rows[0]!.key).toBe("workspace");
    expect(useNotificationHistoryStore.getState().entries.every((e) => e.summarized)).toBe(true);
  });

  it("keeps the project's own entries apart from the app's", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Recipes loaded", context: { projectId: "proj-here" } });
    addEntry({ type: "warning", message: "Disk space low" });

    focusAfter(5000);

    expect(result.current.rows.map((r) => [r.key, r.label])).toEqual([
      ["app", APP_SOURCE_LABEL],
      ["workspace", "This project"],
    ]);
  });

  it("names a scratch workspace's row after the scratch this view was made for", () => {
    vi.mocked(getViewWorkspaceId).mockReturnValue("scratch-1");
    useScratchStore.setState({
      scratches: [scratch("scratch-0", "Decoy"), scratch("scratch-1", "Spike")],
    });
    useProjectStore.setState({ currentProject: project("proj-elsewhere", "Elsewhere") });
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Mine", context: { projectId: "scratch-1" } });
    addEntry({ type: "info", message: "Not mine", context: { projectId: "proj-elsewhere" } });

    focusAfter(5000);

    expect(result.current.rows.map((r) => r.label)).toEqual(["Spike"]);
    expect(result.current.entries.map((e) => e.message)).toEqual(["Mine"]);
  });

  it("falls back to the current project when the view has no workspace id", () => {
    vi.mocked(getViewWorkspaceId).mockReturnValue(null);
    useProjectStore.setState({
      projects: [project("proj-a", "atlas")],
      currentProject: project("proj-a", "atlas"),
    });
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Here", context: { projectId: "proj-a" } });
    addEntry({ type: "info", message: "There", context: { projectId: "proj-b" } });

    focusAfter(5000);

    expect(result.current.entries.map((e) => e.message)).toEqual(["Here"]);
    expect(result.current.rows[0]!.label).toBe("atlas");
  });

  it("gives entries from the app itself a row named after the app", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "warning", message: "Disk space low" });

    focusAfter(5000);

    expect(result.current.visible).toBe(true);
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]!.label).toBe(APP_SOURCE_LABEL);
    expect(result.current.rows[0]!.highlightTitle).toBe("Disk space low");
    expect(useNotificationHistoryStore.getState().entries[0]!.summarized).toBe(true);
  });

  it("leaves out another project's entries and leaves them unsummarized", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "error",
      message: "Elsewhere",
      context: { worktreeId: "/work/other-repo/feature-x", projectId: "proj-other" },
    });
    addEntry({
      type: "info",
      message: "Closed idle project",
      context: { projectId: "proj-other" },
    });
    addEntry({
      type: "success",
      message: "Here",
      context: { worktreeId: "wt-1", projectId: "proj-here" },
    });

    focusAfter(5000);

    expect(result.current.visible).toBe(true);
    expect(result.current.rows.map((r) => r.key)).toEqual(["worktree:wt-1"]);
    expect(result.current.entries.map((e) => e.message)).toEqual(["Here"]);
    const byMessage = new Map(
      useNotificationHistoryStore.getState().entries.map((e) => [e.message, e.summarized])
    );
    expect(byMessage.get("Elsewhere")).toBe(false);
    expect(byMessage.get("Closed idle project")).toBe(false);
    expect(byMessage.get("Here")).toBe(true);
  });

  it("leaves out another host's entries", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Agent waiting", context: { hostName: "build-box" } });
    addEntry({ type: "success", message: "Here", context: { worktreeId: "wt-1" } });

    focusAfter(5000);

    expect(result.current.rows.map((r) => r.key)).toEqual(["worktree:wt-1"]);
    expect(result.current.entries.map((e) => e.message)).toEqual(["Here"]);
    const byMessage = new Map(
      useNotificationHistoryStore.getState().entries.map((e) => [e.message, e.summarized])
    );
    expect(byMessage.get("Agent waiting")).toBe(false);
    expect(byMessage.get("Here")).toBe(true);
  });

  it("claims a panel-only entry only when this view holds the panel", () => {
    usePanelStore.setState({ panelsById: { "panel-here": panel("panel-here") } });
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "warning", message: "Mine", context: { panelId: "panel-here" } });
    addEntry({ type: "warning", message: "Another view's", context: { panelId: "panel-there" } });
    // A project id settles ownership on its own, even once the panel is gone.
    addEntry({
      type: "warning",
      message: "Closed here",
      context: { projectId: "proj-here", panelId: "panel-closed" },
    });

    focusAfter(5000);

    expect(result.current.entries.map((e) => e.message).sort()).toEqual(["Closed here", "Mine"]);
    const byMessage = new Map(
      useNotificationHistoryStore.getState().entries.map((e) => [e.message, e.summarized])
    );
    expect(byMessage.get("Mine")).toBe(true);
    expect(byMessage.get("Closed here")).toBe(true);
    expect(byMessage.get("Another view's")).toBe(false);
  });

  it("times a row by its highlighted entry, not its latest one", () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    now += 1000;
    addEntry({
      type: "error",
      message: "Build failed",
      context: { worktreeId: "wt-1", panelId: "panel-build" },
    });
    const errorAt = now;
    now += 60_000;
    addEntry({
      type: "info",
      message: "Agent idle",
      context: { worktreeId: "wt-1", panelId: "panel-agent" },
    });
    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    Date.now = realNow;

    expect(result.current.rows[0]!.highlightTitle).toBe("Build failed");
    expect(result.current.rows[0]!.highlight.timestamp).toBe(errorAt);
    expect(result.current.rows[0]!.highlight.context?.panelId).toBe("panel-build");
    expect(result.current.shownAt).toBe(now);
  });

  it("highlights the latest of equally severe entries, with its own time and address", () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    // The history prepends, so the later entry is added first: the loop then
    // starts on the older one and has to move to the newer by its timestamp.
    now += 61_000;
    addEntry({
      type: "error",
      message: "Second failure",
      context: { worktreeId: "wt-1", panelId: "panel-second" },
    });
    const secondAt = now;
    now -= 60_000;
    addEntry({
      type: "error",
      message: "First failure",
      context: { worktreeId: "wt-1", panelId: "panel-first" },
    });
    now += 65_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    Date.now = realNow;

    const row = result.current.rows[0]!;
    expect(row.highlightTitle).toBe("Second failure");
    expect(row.highlight.timestamp).toBe(secondAt);
    expect(row.highlight.context?.panelId).toBe("panel-second");
  });

  it("only includes entries created during the blur period", () => {
    const realNow = Date.now;
    let now = 10000;
    Date.now = () => now;

    const { result } = renderHook(() => useReEntrySummary());

    addEntry({
      type: "info",
      message: "Old low-priority",
      context: { worktreeId: "wt-old" },
    });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    now += 1000;
    addEntry({
      type: "error",
      message: "During blur",
      context: { worktreeId: "wt-new" },
    });

    now += 4000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.message).toBe("During blur");
  });
});

describe("useReEntrySummary across a screen lock (#14885)", () => {
  let pushPolicy: ((snapshot: PowerPolicySnapshot) => void) | null = null;
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;
  let now = 0;

  function setScreenLocked(locked: boolean): void {
    act(() => {
      pushPolicy!({
        level: locked ? "deep" : "active",
        canObserve: !locked,
        onBattery: false,
        screenLocked: locked,
        anyWindowFocused: true,
        anyWindowVisible: true,
      });
    });
  }

  beforeEach(async () => {
    pushPolicy = null;
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        events: {
          on: (name: string, cb: (snapshot: PowerPolicySnapshot) => void) => {
            if (name === "system:power-policy-changed") pushPolicy = cb;
            return () => {};
          },
        },
      },
    });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useProjectStore.setState({ projects: [], currentProject: null });
    usePanelStore.setState({ panelsById: {} });
    vi.mocked(getViewWorkspaceId).mockReturnValue("proj-here");
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue(null);
    // A locked screen fires no blur: the window still reports focus.
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "electron");
    __resetPowerPolicyStateForTests();
  });

  it("shows the summary on unlock for what was raised during the lock", () => {
    const { result } = renderHook(() => useReEntrySummary());
    addEntry({ type: "info", message: "Before the lock", context: { worktreeId: "wt-1" } });

    now += 1000;
    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "During the lock", context: { worktreeId: "wt-1" } });
    now += 60_000;
    setScreenLocked(false);

    expect(result.current.visible).toBe(true);
    expect(result.current.entries.map((e) => e.message)).toEqual(["During the lock"]);
  });

  it("shows nothing after a lock shorter than the blur threshold", () => {
    const { result } = renderHook(() => useReEntrySummary());

    setScreenLocked(true);
    addEntry({ type: "error", message: "During the lock" });
    now += 1000;
    setScreenLocked(false);

    expect(result.current.visible).toBe(false);
  });

  it("waits for focus when the screen unlocks into a window without it", () => {
    const { result } = renderHook(() => useReEntrySummary());

    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "During the lock" });
    // The window blurs partway through the lock; the lock still started first.
    now += 1000;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    now += 60_000;
    hasFocusSpy.mockReturnValue(false);
    setScreenLocked(false);
    expect(result.current.visible).toBe(false);

    now += 10_000;
    hasFocusSpy.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.entries.map((e) => e.message)).toEqual(["During the lock"]);
  });

  it("waits for the unlock when focus lands on a locked screen", () => {
    const { result } = renderHook(() => useReEntrySummary());

    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "During the lock" });
    now += 60_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.visible).toBe(false);

    setScreenLocked(false);

    expect(result.current.visible).toBe(true);
  });

  it("spends both the blur and the lock on one return", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "While away" });
    now += 60_000;
    setScreenLocked(false);
    expect(result.current.visible).toBe(true);
    act(() => {
      result.current.dismiss();
    });

    now += 1000;
    addEntry({ type: "error", message: "After the return" });
    now += 60_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.visible).toBe(false);
    const after = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message === "After the return");
    expect(after?.summarized).toBe(false);
  });

  it("counts from a blur that came before the lock", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    now += 1000;
    addEntry({ type: "error", message: "Between the blur and the lock" });
    now += 1000;
    setScreenLocked(true);
    now += 60_000;
    setScreenLocked(false);

    expect(result.current.entries.map((e) => e.message)).toEqual(["Between the blur and the lock"]);
  });

  it("reads focus a frame after the focus event, where it is current", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const { result } = renderHook(() => useReEntrySummary());

    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "During the lock" });
    now += 60_000;
    hasFocusSpy.mockReturnValue(false);
    setScreenLocked(false);
    // Stale inside the handler; current by the frame.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    hasFocusSpy.mockReturnValue(true);
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(result.current.visible).toBe(true);
  });

  it("keeps the absence's start when a blur lands before the focus frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    now += 1000;
    addEntry({ type: "error", message: "Early in the absence" });
    now += 60_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("blur"));
    });
    frames.splice(0);
    now += 60_000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(result.current.entries.map((e) => e.message)).toEqual(["Early in the absence"]);
  });

  it("keeps the earliest start when the screen locks again before the return", () => {
    const { result } = renderHook(() => useReEntrySummary());

    setScreenLocked(true);
    now += 1000;
    addEntry({ type: "error", message: "During the first lock" });
    now += 60_000;
    hasFocusSpy.mockReturnValue(false);
    setScreenLocked(false);
    setScreenLocked(true);
    now += 60_000;
    hasFocusSpy.mockReturnValue(true);
    setScreenLocked(false);

    expect(result.current.entries.map((e) => e.message)).toEqual(["During the first lock"]);
  });

  it("counts from mount when the view comes up on a locked screen", () => {
    isScreenLocked();
    setScreenLocked(true);
    addEntry({ type: "error", message: "Before the view came up" });
    now += 60_000;
    const { result } = renderHook(() => useReEntrySummary());

    now += 1000;
    addEntry({ type: "error", message: "After the view came up" });
    now += 60_000;
    setScreenLocked(false);

    expect(result.current.entries.map((e) => e.message)).toEqual(["After the view came up"]);
  });

  it("times a view that came up on a locked screen from its mount, not the lock", () => {
    isScreenLocked();
    setScreenLocked(true);
    now += 60_000;
    const { result } = renderHook(() => useReEntrySummary());

    addEntry({ type: "error", message: "After the view came up" });
    now += 1000;
    setScreenLocked(false);

    expect(result.current.visible).toBe(false);
  });
});
