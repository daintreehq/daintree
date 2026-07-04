import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import type { TrashedTerminal } from "../types";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

function seedPanel(id: string, location: "grid" | "dock" | "trash") {
  const panel = {
    id,
    title: id,
    kind: "terminal" as const,
    type: "terminal" as const,
    location,
    worktreeId: "wt-1",
    isVisible: true,
  } as unknown as PtyPanelData;
  usePanelStore.setState((state) => ({
    panelsById: { ...state.panelsById, [id]: panel },
    panelIds: state.panelIds.includes(id) ? state.panelIds : [...state.panelIds, id],
  }));
}

function seedTrashEntry(id: string) {
  const entry: TrashedTerminal = {
    id,
    expiresAt: 1_000,
    originalLocation: "grid",
  };
  usePanelStore.setState((state) => {
    const trashedTerminals = new Map(state.trashedTerminals);
    trashedTerminals.set(id, entry);
    return { trashedTerminals };
  });
}

function seedTrashGroupEntry(id: string, groupRestoreId: string) {
  const entry: TrashedTerminal = {
    id,
    expiresAt: 1_000,
    originalLocation: "grid",
    groupRestoreId,
  };
  usePanelStore.setState((state) => {
    const trashedTerminals = new Map(state.trashedTerminals);
    trashedTerminals.set(id, entry);
    return { trashedTerminals };
  });
}

describe("restoreLastTrashed boolean contract", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await usePanelStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when the trash is empty", () => {
    expect(usePanelStore.getState().restoreLastTrashed()).toBe(false);
  });

  it("restores a live trashed panel and returns true", () => {
    seedPanel("term-1", "trash");
    seedTrashEntry("term-1");

    const restored = usePanelStore.getState().restoreLastTrashed();

    expect(restored).toBe(true);
    // The restore consumed the trash entry (moved the panel back out of trash).
    expect(usePanelStore.getState().trashedTerminals.has("term-1")).toBe(false);
    expect(usePanelStore.getState().panelsById["term-1"]?.location).not.toBe("trash");
  });

  it("returns false and drops a stale entry whose panel row is gone", () => {
    // Map entry survives but the panel was already removed from panelsById —
    // a real drift path (throttled expiry timer + no-op restore without cleanup).
    seedTrashEntry("ghost");

    const restored = usePanelStore.getState().restoreLastTrashed();

    expect(restored).toBe(false);
    expect(usePanelStore.getState().trashedTerminals.has("ghost")).toBe(false);
  });

  it("returns false when the entry's panel is no longer in trash", () => {
    // Panel exists but was already restored elsewhere (location back to grid);
    // the lingering map entry must not report a phantom success.
    seedPanel("moved", "grid");
    seedTrashEntry("moved");

    const restored = usePanelStore.getState().restoreLastTrashed();

    expect(restored).toBe(false);
    expect(usePanelStore.getState().trashedTerminals.has("moved")).toBe(false);
  });

  it("returns false and drops stale entries for a fully-ghosted group", () => {
    // Every member of the group was already pruned from panelsById (same
    // throttled-expiry-timer race as the single-panel ghost case), but the
    // trashedTerminals map entries linger — restoreTrashedGroup would be a
    // silent no-op that must not report a phantom success.
    seedTrashGroupEntry("ghost-a", "group-1");
    seedTrashGroupEntry("ghost-b", "group-1");

    const restored = usePanelStore.getState().restoreLastTrashed();

    expect(restored).toBe(false);
    expect(usePanelStore.getState().trashedTerminals.has("ghost-a")).toBe(false);
    expect(usePanelStore.getState().trashedTerminals.has("ghost-b")).toBe(false);
  });

  it("restores a group with at least one surviving member and returns true", () => {
    // One member of the group still exists in panelsById with location
    // "trash"; the group restore should proceed and report success even
    // though a sibling member was already pruned.
    seedPanel("live-a", "trash");
    seedTrashGroupEntry("live-a", "group-2");
    seedTrashGroupEntry("ghost-c", "group-2");

    const restored = usePanelStore.getState().restoreLastTrashed();

    expect(restored).toBe(true);
    expect(usePanelStore.getState().trashedTerminals.has("live-a")).toBe(false);
    expect(usePanelStore.getState().trashedTerminals.has("ghost-c")).toBe(false);
  });
});
