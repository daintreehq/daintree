// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const spy = vi.hoisted(() => ({ renders: [] as Record<string, unknown>[] }));

vi.mock("@/registry", async () => {
  const { memo } = await import("react");
  const Panel = memo(function PanelSpy(props: Record<string, unknown>) {
    spy.renders.push(props);
    return null;
  });
  const definitions = { terminal: { component: Panel } };
  return {
    getPanelKindDefinitionsSnapshot: () => definitions,
    subscribeToPanelKindDefinitions: () => () => {},
  };
});

vi.mock("@/store", async () => {
  const { usePanelStore } = await import("@/store/panelStore");
  return { usePanelStore };
});

import { GridPanel } from "../GridPanel";
import { usePanelStore } from "@/store/panelStore";
import {
  cancelPanelStatusBuffer,
  enqueueActivityUpdate,
  enqueueFlowStatusUpdate,
  enqueueHeldDurationUpdate,
  flushPanelStatusBuffer,
} from "@/store/panelStatusBuffer";

const initial = usePanelStore.getState();
const ID = "t1";

function pty(fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: ID,
    kind: "terminal",
    title: "t1",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    detectedAgentId: "claude",
    agentState: "working",
    runtimeStatus: "running",
    flowStatus: "running",
    flowStatusTimestamp: 1,
    activityHeadline: "Running tests",
    activityStatus: "working",
    activityType: "interactive",
    lastCommand: "npm test",
    lastObservedTitle: "Fix auth",
    stateChangeTrigger: "output",
    ...fields,
  };
}

describe("GridPanel while a terminal streams", () => {
  beforeEach(() => {
    spy.renders.length = 0;
    usePanelStore.setState({
      panelsById: { [ID]: pty() as PanelInstance },
      panelIds: [ID],
      focusedId: ID,
    });
    render(<GridPanel terminalId={ID} isFocused />);
  });

  afterEach(() => {
    cleanup();
    cancelPanelStatusBuffer();
    usePanelStore.setState(initial, true);
  });

  it("renders nothing more across 120 frames of repeated status reports", () => {
    const before = spy.renders.length;
    const store = usePanelStore.getState();
    for (let frame = 0; frame < 120; frame++) {
      act(() => {
        enqueueActivityUpdate(ID, "Running tests", "working", "interactive", "npm test");
        enqueueFlowStatusUpdate(ID, "running", 1);
        flushPanelStatusBuffer();
        store.updateAgentState(ID, "working", undefined, undefined, "output");
        store.updateLastObservedTitle(ID, "Fix auth");
      });
    }
    expect(spy.renders.length).toBe(before);
  });

  it("renders nothing more when a pause and resume land in one frame", () => {
    const before = spy.renders.length;
    for (let ts = 2; ts < 22; ts += 2) {
      act(() => {
        enqueueFlowStatusUpdate(ID, "paused-backpressure", ts);
        enqueueFlowStatusUpdate(ID, "running", ts + 1);
        flushPanelStatusBuffer();
      });
    }
    expect(usePanelStore.getState().panelsById[ID]).toMatchObject({
      flowStatus: "running",
      flowStatusTimestamp: 21,
    });
    expect(spy.renders.length).toBe(before);
  });

  it("renders nothing more while the held-duration gauge ticks", () => {
    const before = spy.renders.length;
    for (const ms of [2_000, 4_000, 6_000]) {
      act(() => {
        enqueueHeldDurationUpdate(ID, ms);
        flushPanelStatusBuffer();
      });
    }
    expect(usePanelStore.getState().panelsById[ID]).toMatchObject({ heldDurationMs: 6_000 });
    expect(spy.renders.length).toBe(before);
  });

  it("still renders when a visible field changes", () => {
    const before = spy.renders.length;
    act(() =>
      usePanelStore.getState().updateAgentState(ID, "waiting", undefined, Date.now(), "output")
    );
    expect(spy.renders.length).toBeGreaterThan(before);
    expect(spy.renders.at(-1)?.agentState).toBe("waiting");
  });
});
