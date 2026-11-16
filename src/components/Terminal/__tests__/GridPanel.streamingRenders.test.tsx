// @vitest-environment jsdom
/**
 * A streaming terminal's grid cell renders only when something it draws
 * changes (#17052). The store keeps bookkeeping on the panel (a flow-status
 * ordering timestamp, the held-duration gauge, the last agent observation)
 * that a pause and resume in one frame, a paused pane's 2s gauge, or a host
 * confirmation rewrites without changing anything on screen. `GridPanel`'s
 * own executions are counted through its panel hook, and the pane is a
 * memoized spy, so each call it records is a render the real one would do.
 */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const spy = vi.hoisted(() => ({ pane: [] as Record<string, unknown>[], cell: 0 }));

vi.mock("@/registry", async () => {
  const { memo } = await import("react");
  const Panel = memo(function PanelSpy(props: Record<string, unknown>) {
    spy.pane.push(props);
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

vi.mock("../gridPanelSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gridPanelSelection")>();
  return {
    ...actual,
    useGridPanel: (id: string) => {
      spy.cell++;
      return actual.useGridPanel(id);
    },
  };
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

function current(): PtyPanelData {
  return usePanelStore.getState().panelsById[ID] as PtyPanelData;
}

function patch(fields: Partial<PtyPanelData>) {
  act(() => {
    usePanelStore.setState((state) => ({
      panelsById: { ...state.panelsById, [ID]: { ...current(), ...fields } as PanelInstance },
    }));
  });
}

const counts = () => ({ cell: spy.cell, pane: spy.pane.length });
const lastPane = () => spy.pane[spy.pane.length - 1]!;

describe.each([
  ["", false],
  [" under StrictMode", true],
])("GridPanel while a terminal streams%s", (_label, strict) => {
  beforeEach(() => {
    spy.pane.length = 0;
    spy.cell = 0;
    usePanelStore.setState({
      panelsById: { [ID]: pty() as PanelInstance },
      panelIds: [ID],
      focusedId: ID,
    });
    const tree = <GridPanel terminalId={ID} isFocused />;
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    expect(spy.pane.length).toBeGreaterThan(0);
    expect(spy.cell).toBeGreaterThan(0);
  });

  afterEach(() => {
    cleanup();
    cancelPanelStatusBuffer();
    usePanelStore.setState(initial, true);
  });

  it("renders nothing more across 120 frames of repeated status reports", () => {
    const before = counts();
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
    expect(counts()).toEqual(before);
  });

  it("renders nothing more when a pause and resume land in one frame", () => {
    const before = counts();
    for (let ts = 2; ts < 22; ts += 2) {
      act(() => {
        enqueueFlowStatusUpdate(ID, "paused-backpressure", ts);
        enqueueFlowStatusUpdate(ID, "running", ts + 1);
        flushPanelStatusBuffer();
      });
    }
    expect(current()).toMatchObject({ flowStatus: "running", flowStatusTimestamp: 21 });
    expect(counts()).toEqual(before);
  });

  it("renders nothing more while the held-duration gauge ticks", () => {
    const before = counts();
    for (const ms of [2_000, 4_000, 6_000]) {
      act(() => {
        enqueueHeldDurationUpdate(ID, ms);
        flushPanelStatusBuffer();
      });
    }
    expect(current()).toMatchObject({ heldDurationMs: 6_000 });
    expect(counts()).toEqual(before);
  });

  it("renders nothing more when the host confirms the state already shown", () => {
    const before = counts();
    act(() => usePanelStore.getState().updateAgentState(ID, "working", undefined, 5_000, "output"));
    expect(current().lastAgentObservation).toEqual({ agentState: "working", at: 5_000 });
    expect(counts()).toEqual(before);
  });

  it("renders a visible change that lands with a bookkeeping one", () => {
    const before = counts();
    patch({ flowStatusTimestamp: 30, title: "Renamed" });
    expect(counts().pane).toBeGreaterThan(before.pane);
    expect(lastPane().title).toBe("Renamed");
  });

  it.each<[string, Partial<PtyPanelData>, Record<string, unknown>]>([
    ["agent state", { agentState: "waiting" }, { agentState: "waiting" }],
    ["cwd", { cwd: "/elsewhere" }, { cwd: "/elsewhere" }],
    ["flow status", { flowStatus: "paused-backpressure" }, {}],
    ["activity", { activityHeadline: "Editing files" }, {}],
    [
      "extension state",
      { extensionState: { k: 1 }, extensionStateVersion: 2 },
      { extensionState: { k: 1 }, extensionStateVersion: 2 },
    ],
  ])("renders a %s change straight away", (_name, fields, expected) => {
    const before = counts();
    patch(fields);
    expect(counts().cell).toBeGreaterThan(before.cell);
    expect(counts().pane).toBeGreaterThan(before.pane);
    expect(lastPane()).toMatchObject(expected);
  });

  it("renders the exit in the pane's chrome", () => {
    patch({ runtimeStatus: "exited", exitCode: 1 });
    expect((lastPane().chrome as { hasExited: boolean }).hasExited).toBe(true);
  });
});
