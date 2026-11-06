import { afterEach, describe, expect, it } from "vitest";
import type { BrowserPanelData, PanelInstance, PtyPanelData } from "@shared/types/panel";
import {
  _resetPanelFailureStoreForTest,
  observePanelFailures,
  usePanelFailureStore,
  type PanelFailureSource,
} from "../panelFailureStore";

type Fields = Partial<PtyPanelData>;

function terminal(fields: Fields, id = "t-1"): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    ...fields,
  };
}

/** Feeds the store one record write per call, the way the panel store's subscription does. */
function recorder() {
  let prev: Record<string, PanelInstance> | undefined;
  return (records: Record<string, Fields>) => {
    const next: Record<string, PanelInstance> = {};
    for (const [id, fields] of Object.entries(records)) next[id] = terminal(fields, id);
    observePanelFailures(next, prev);
    prev = next;
  };
}

const tokenOf = (source: PanelFailureSource, id = "t-1") =>
  usePanelFailureStore.getState().occurrences[id]?.[source]?.token;

const ERROR_WAIT = { agentState: "waiting", waitingReason: "error" } as const;
const FAILED_EXIT = { runtimeStatus: "exited", exitCode: 1 } as const;
const restartError = (timestamp: number) => ({
  restartError: { message: "cwd gone", timestamp, recoverable: true },
});
const reconnectError = (timestamp: number, type: "not_found" | "error" = "not_found") => ({
  reconnectError: { message: "gone", type, timestamp },
});
const SPAWN_ERROR = { spawnError: { code: "ENOENT", message: "claude: not found" } } as const;

afterEach(() => {
  _resetPanelFailureStoreForTest();
});

describe("panelFailureStore occurrences", () => {
  it("keeps one error wait one failure while its timestamp, error text and trigger move", () => {
    const write = recorder();
    write({ "t-1": { ...ERROR_WAIT, lastStateChange: 1, error: "rate limit" } });
    const first = tokenOf("wait");
    expect(first).toBeDefined();

    write({
      "t-1": {
        ...ERROR_WAIT,
        lastStateChange: 2,
        error: "overloaded",
        stateChangeTrigger: "output",
      },
    });
    expect(tokenOf("wait")).toBe(first);
  });

  it("reads a wait that ends and comes back as a new failure, and a plain wait as none", () => {
    const write = recorder();
    write({ "t-1": ERROR_WAIT });
    const first = tokenOf("wait");
    expect(first).toBeDefined();

    write({ "t-1": { agentState: "working" } });
    expect(tokenOf("wait")).toBeUndefined();
    write({ "t-1": { agentState: "waiting", waitingReason: "prompt" } });
    expect(tokenOf("wait")).toBeUndefined();

    write({ "t-1": ERROR_WAIT });
    expect(tokenOf("wait")).toBeDefined();
    expect(tokenOf("wait")).not.toBe(first);
  });

  it("reads a new agent session's error wait as new, but not the session count filling in", () => {
    const write = recorder();
    write({ "t-1": ERROR_WAIT });
    const first = tokenOf("wait");
    expect(first).toBeDefined();
    write({ "t-1": { ...ERROR_WAIT, agentIncarnation: 0 } });
    expect(tokenOf("wait")).toBe(first);

    // A resync lands the next session's error wait straight on this one's.
    write({ "t-1": { ...ERROR_WAIT, agentIncarnation: 1 } });
    expect(tokenOf("wait")).toBeDefined();
    expect(tokenOf("wait")).not.toBe(first);
  });

  it("ends an error wait on a restart or an exit", () => {
    const write = recorder();
    write({ "t-1": ERROR_WAIT });
    expect(tokenOf("wait")).toBeDefined();
    write({ "t-1": { ...ERROR_WAIT, isRestarting: true } });
    expect(tokenOf("wait")).toBeUndefined();

    write({ "t-1": ERROR_WAIT });
    expect(tokenOf("wait")).toBeDefined();
    write({ "t-1": { ...ERROR_WAIT, runtimeStatus: "exited" } });
    expect(tokenOf("wait")).toBeUndefined();
  });

  it("reads only a failed exit the pane shows", () => {
    const write = recorder();
    const notFailed: Fields[] = [
      { runtimeStatus: "exited", exitCode: 0 },
      { runtimeStatus: "exited", exitCode: 130 },
      { runtimeStatus: "exited" },
      // A live terminal still carrying an old code is not exited.
      { runtimeStatus: "running", exitCode: 1 },
    ];
    for (const fields of notFailed) {
      write({ "t-1": fields });
      expect(tokenOf("exit"), JSON.stringify(fields)).toBeUndefined();
    }
    write({ "t-1": FAILED_EXIT });
    expect(tokenOf("exit")).toBeDefined();
  });

  it("keeps a failed exit through a rebuilt record, and reads the next one as new", () => {
    const write = recorder();
    write({ "t-1": { ...FAILED_EXIT, restartKey: 2, startedAt: 10 } });
    const first = tokenOf("exit");
    expect(first).toBeDefined();
    // A reconnect replaces the record and stamps a new start without a restart.
    write({ "t-1": { ...FAILED_EXIT, startedAt: 20 } });
    expect(tokenOf("exit")).toBe(first);

    // A restart clears the exit; the next failed exit is another failure.
    write({ "t-1": { restartKey: 3 } });
    write({ "t-1": { ...FAILED_EXIT, restartKey: 3 } });
    expect(tokenOf("exit")).toBeDefined();
    expect(tokenOf("exit")).not.toBe(first);
  });

  it("reads a restart error replaced by a later one as a new failure", () => {
    const write = recorder();
    write({ "t-1": restartError(1) });
    const first = tokenOf("restart");
    expect(first).toBeDefined();
    write({ "t-1": { ...restartError(1), title: "renamed" } });
    expect(tokenOf("restart")).toBe(first);

    write({ "t-1": restartError(2) });
    expect(tokenOf("restart")).toBeDefined();
    expect(tokenOf("restart")).not.toBe(first);
  });

  it("reads a reconnect error replaced by a later or different one as new, and leaves a timeout out", () => {
    const write = recorder();
    write({ "t-1": { reconnectError: { message: "slow", type: "timeout", timestamp: 1 } } });
    expect(tokenOf("reconnect")).toBeUndefined();

    write({ "t-1": reconnectError(2) });
    const first = tokenOf("reconnect");
    expect(first).toBeDefined();
    write({ "t-1": { ...reconnectError(2), title: "renamed" } });
    expect(tokenOf("reconnect")).toBe(first);

    write({ "t-1": reconnectError(3) });
    const second = tokenOf("reconnect");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    write({ "t-1": reconnectError(3, "error") });
    expect(tokenOf("reconnect")).toBeDefined();
    expect(tokenOf("reconnect")).not.toBe(second);
  });

  it("reads a spawn error as one failure until it clears", () => {
    const write = recorder();
    write({ "t-1": SPAWN_ERROR });
    const first = tokenOf("spawn");
    expect(first).toBeDefined();
    write({ "t-1": { spawnError: { code: "EACCES", message: "refined" } } });
    expect(tokenOf("spawn")).toBe(first);
    write({ "t-1": {} });
    expect(tokenOf("spawn")).toBeUndefined();
  });

  it("reads nothing from a panel that isn't a terminal", () => {
    const browser: BrowserPanelData = {
      id: "b-1",
      kind: "browser",
      title: "b-1",
      location: "grid",
    };
    observePanelFailures({ "b-1": { ...browser, ...FAILED_EXIT } });
    expect(usePanelFailureStore.getState().occurrences["b-1"]).toBeUndefined();
  });

  it("gives every failed submit its own failure, even back to back", () => {
    const { noteSubmitFailure } = usePanelFailureStore.getState();
    noteSubmitFailure("t-1");
    const first = tokenOf("submit");
    expect(first).toBeDefined();
    noteSubmitFailure("t-1");
    expect(tokenOf("submit")).toBeDefined();
    expect(tokenOf("submit")).not.toBe(first);
  });
});

describe("panelFailureStore seen marks", () => {
  it("keeps marks for one source when another is marked later", () => {
    const write = recorder();
    write({ "t-1": { ...FAILED_EXIT, ...SPAWN_ERROR } });
    const exit = tokenOf("exit");
    const spawn = tokenOf("spawn");
    expect(exit).toBeDefined();
    expect(spawn).toBeDefined();
    const { markSeen } = usePanelFailureStore.getState();
    markSeen("t-1", { exit });
    markSeen("t-1", { spawn });

    const seen = usePanelFailureStore.getState().seen["t-1"];
    expect(seen?.exit).toBe(exit);
    expect(seen?.spawn).toBe(spawn);
  });

  it("keeps a seen failure seen when another one beside it clears", () => {
    const write = recorder();
    write({ "t-1": { ...FAILED_EXIT, ...restartError(1) } });
    const exit = tokenOf("exit");
    expect(exit).toBeDefined();
    usePanelFailureStore.getState().markSeen("t-1", { exit, restart: tokenOf("restart") });

    write({ "t-1": FAILED_EXIT });
    const marks = usePanelFailureStore.getState().seen["t-1"];
    expect(marks?.exit).toBe(exit);
    expect(marks?.restart).toBeUndefined();

    // The last failure clearing takes its panel's marks with it.
    write({ "t-1": {} });
    expect("t-1" in usePanelFailureStore.getState().seen).toBe(false);
    expect("t-1" in usePanelFailureStore.getState().occurrences).toBe(false);
  });

  it("writes nothing when no failure changed, and forgets only the removed panel", () => {
    const write = recorder();
    write({ "t-1": FAILED_EXIT, "t-2": SPAWN_ERROR });
    expect(tokenOf("exit")).toBeDefined();
    const before = usePanelFailureStore.getState();
    write({ "t-1": FAILED_EXIT, "t-2": { ...SPAWN_ERROR, title: "renamed" } });
    expect(usePanelFailureStore.getState()).toBe(before);

    const { markSeen, removePanel } = usePanelFailureStore.getState();
    markSeen("t-1", { exit: tokenOf("exit") });
    markSeen("t-2", { spawn: tokenOf("spawn", "t-2") });
    removePanel("t-1");
    const { occurrences, seen } = usePanelFailureStore.getState();
    expect("t-1" in occurrences).toBe(false);
    expect("t-1" in seen).toBe(false);
    expect(occurrences["t-2"]?.spawn?.token).toBeDefined();
    expect(seen["t-2"]?.spawn).toBe(occurrences["t-2"]?.spawn?.token);
  });
});
