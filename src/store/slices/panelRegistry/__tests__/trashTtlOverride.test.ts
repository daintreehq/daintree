// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const mockProjectClient = {
  getTerminals: vi.fn().mockResolvedValue([]),
  setTerminals: vi.fn().mockResolvedValue(undefined),
  setTabGroups: vi.fn().mockResolvedValue(undefined),
};

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
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: mockProjectClient,
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

const { getTrashTtlMs } = await import("../trash");
const { TRASH_TTL_MS } = await import("@shared/config/trash");

const OVERRIDE_KEY = "__DAINTREE_E2E_TRASH_TTL_MS__";

function setOverride(value: unknown): void {
  Reflect.set(window, OVERRIDE_KEY, value);
}

function seedGridPanel(id: string): void {
  const panel: PanelInstance = {
    id,
    title: `Panel ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid",
    kind: "terminal",
  };
  usePanelStore.setState({ panelsById: { [id]: panel }, panelIds: [id] });
}

describe("trash TTL E2E override", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    await usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, OVERRIDE_KEY);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses the product TTL when the preload exposes no override", () => {
    expect(getTrashTtlMs()).toBe(TRASH_TTL_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3000", null])(
    "ignores a malformed override %j",
    (value) => {
      setOverride(value);
      expect(getTrashTtlMs()).toBe(TRASH_TTL_MS);
    }
  );

  it("expires a trashed panel at the overridden TTL, not the product one", () => {
    setOverride(3_000);
    const now = Date.now();
    seedGridPanel("p-1");

    usePanelStore.getState().trashPanel("p-1");
    expect(usePanelStore.getState().trashedTerminals.get("p-1")?.expiresAt).toBe(now + 3_000);

    vi.advanceTimersByTime(2_999);
    expect(usePanelStore.getState().panelsById["p-1"]?.location).toBe("trash");

    vi.advanceTimersByTime(1);
    expect(usePanelStore.getState().panelsById["p-1"]).toBeUndefined();
    expect(usePanelStore.getState().trashedTerminals.has("p-1")).toBe(false);
  });

  it("keeps the product TTL for a trashed panel without an override", () => {
    const now = Date.now();
    seedGridPanel("p-2");

    usePanelStore.getState().trashPanel("p-2");
    expect(usePanelStore.getState().trashedTerminals.get("p-2")?.expiresAt).toBe(
      now + TRASH_TTL_MS
    );

    vi.advanceTimersByTime(3_000);
    expect(usePanelStore.getState().panelsById["p-2"]?.location).toBe("trash");
  });
});
