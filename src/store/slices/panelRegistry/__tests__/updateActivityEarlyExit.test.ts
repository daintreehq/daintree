/**
 * Tests for updateActivity early-exit optimization (#2701)
 *
 * updateActivity should not replace the terminals array reference when the
 * incoming activity data is identical to what's already stored. This prevents
 * unnecessary re-renders for all components subscribed to the terminal store.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
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

const { usePanelStore } = await import("../../../panelStore");

const baseTerminal = {
  id: "test-terminal-1",
  type: "terminal" as const,
  kind: "terminal" as const,
  title: "Test",
  cwd: "/test",
  cols: 80,
  rows: 24,
  location: "grid" as const,
  activityHeadline: "Running tests",
  activityStatus: "working" as const,
  activityType: "background" as const,
  activityTimestamp: 1000,
  lastCommand: "npm test",
};

describe("updateActivity early-exit (#2701)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  it("preserves array reference when activity data is unchanged", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("replaces array reference when headline changes", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        "Tests passed",
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.activityHeadline).toBe("Tests passed");
  });

  it("replaces array reference when status changes", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        "success",
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.activityStatus).toBe("success");
  });

  it("replaces array reference when timestamp changes", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        2000,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.activityTimestamp).toBe(2000);
  });

  it("replaces array reference when activityType changes", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        "interactive",
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.activityType).toBe("interactive");
  });

  it("replaces array reference when lastCommand changes", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        "npm run build"
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.lastCommand).toBe("npm run build");
  });

  it("preserves array reference for unchanged terminal when sibling terminal differs", () => {
    const sibling = { ...baseTerminal, id: "test-terminal-2", title: "Sibling" };
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal, [sibling.id]: sibling },
      panelIds: [baseTerminal.id, sibling.id],
    });

    const before = usePanelStore.getState().panelsById;
    const siblingBefore = before[sibling.id];

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).toBe(before);
    expect(after[sibling.id]).toBe(siblingBefore);
  });

  it("updates only the target terminal when multiple terminals exist", () => {
    const sibling = { ...baseTerminal, id: "test-terminal-2", title: "Sibling" };
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal, [sibling.id]: sibling },
      panelIds: [baseTerminal.id, sibling.id],
    });

    const before = usePanelStore.getState().panelsById;
    const siblingBefore = before[sibling.id];

    usePanelStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        "Updated headline",
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        2000,
        baseTerminal.lastCommand
      );

    const after = usePanelStore.getState().panelsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id]!.activityHeadline).toBe("Updated headline");
    expect(after[sibling.id]).toBe(siblingBefore);
  });

  it("preserves array reference when terminal id is not found", () => {
    usePanelStore.setState({
      panelsById: { [baseTerminal.id]: baseTerminal },
      panelIds: [baseTerminal.id],
    });

    const before = usePanelStore.getState().panelsById;

    usePanelStore
      .getState()
      .updateActivity("nonexistent-id", "Working", "working", "background", 1000);

    expect(usePanelStore.getState().panelsById).toBe(before);
  });
});
