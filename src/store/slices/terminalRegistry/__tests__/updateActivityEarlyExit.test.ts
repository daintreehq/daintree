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

const { useTerminalStore } = await import("../../../terminalStore");

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
    const { reset } = useTerminalStore.getState();
    await reset();
    useTerminalStore.setState({
      terminalsById: {},
      terminalIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  it("preserves array reference when activity data is unchanged", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    expect(useTerminalStore.getState().terminalsById).toBe(before);
  });

  it("replaces array reference when headline changes", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        "Tests passed",
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].activityHeadline).toBe("Tests passed");
  });

  it("replaces array reference when status changes", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        "success",
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].activityStatus).toBe("success");
  });

  it("replaces array reference when timestamp changes", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        2000,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].activityTimestamp).toBe(2000);
  });

  it("replaces array reference when activityType changes", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        "interactive",
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].activityType).toBe("interactive");
  });

  it("replaces array reference when lastCommand changes", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        "npm run build"
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].lastCommand).toBe("npm run build");
  });

  it("preserves array reference for unchanged terminal when sibling terminal differs", () => {
    const sibling = { ...baseTerminal, id: "test-terminal-2", title: "Sibling" };
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal, [sibling.id]: sibling },
      terminalIds: [baseTerminal.id, sibling.id],
    });

    const before = useTerminalStore.getState().terminalsById;
    const siblingBefore = before[sibling.id];

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        baseTerminal.activityHeadline,
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        baseTerminal.activityTimestamp,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).toBe(before);
    expect(after[sibling.id]).toBe(siblingBefore);
  });

  it("updates only the target terminal when multiple terminals exist", () => {
    const sibling = { ...baseTerminal, id: "test-terminal-2", title: "Sibling" };
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal, [sibling.id]: sibling },
      terminalIds: [baseTerminal.id, sibling.id],
    });

    const before = useTerminalStore.getState().terminalsById;
    const siblingBefore = before[sibling.id];

    useTerminalStore
      .getState()
      .updateActivity(
        baseTerminal.id,
        "Updated headline",
        baseTerminal.activityStatus,
        baseTerminal.activityType,
        2000,
        baseTerminal.lastCommand
      );

    const after = useTerminalStore.getState().terminalsById;
    expect(after).not.toBe(before);
    expect(after[baseTerminal.id].activityHeadline).toBe("Updated headline");
    expect(after[sibling.id]).toBe(siblingBefore);
  });

  it("preserves array reference when terminal id is not found", () => {
    useTerminalStore.setState({
      terminalsById: { [baseTerminal.id]: baseTerminal },
      terminalIds: [baseTerminal.id],
    });

    const before = useTerminalStore.getState().terminalsById;

    useTerminalStore
      .getState()
      .updateActivity("nonexistent-id", "Working", "working", "background", 1000);

    expect(useTerminalStore.getState().terminalsById).toBe(before);
  });
});
