import { afterEach, describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import {
  _resetPanelFailureStoreForTest,
  observePanelFailures,
  usePanelFailureStore,
} from "../panelFailureStore";

type Fields = Record<string, unknown>;

function terminal(fields: Fields, id = "t-1"): PanelInstance {
  return { id, kind: "terminal", title: id, location: "grid", ...fields } as never;
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

const tokenOf = (source: string, id = "t-1") =>
  (
    usePanelFailureStore.getState().occurrences[id] as Record<string, { token: number }> | undefined
  )?.[source]?.token;

const ERROR_WAIT = { agentState: "waiting", waitingReason: "error" };
const FAILED_EXIT = { runtimeStatus: "exited", exitCode: 1 };

afterEach(() => {
  _resetPanelFailureStoreForTest();
});

describe("panelFailureStore", () => {
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

  it("reads a wait that ends and comes back as a new failure", () => {
    const write = recorder();
    write({ "t-1": ERROR_WAIT });
    const first = tokenOf("wait");

    write({ "t-1": { agentState: "working" } });
    expect(tokenOf("wait")).toBeUndefined();

    write({ "t-1": ERROR_WAIT });
    expect(tokenOf("wait")).toBeDefined();
    expect(tokenOf("wait")).not.toBe(first);
  });

  it("ends an error wait on a restart or an exit", () => {
    const write = recorder();
    write({ "t-1": ERROR_WAIT });
    write({ "t-1": { ...ERROR_WAIT, isRestarting: true } });
    expect(tokenOf("wait")).toBeUndefined();

    write({ "t-1": ERROR_WAIT });
    write({ "t-1": { ...ERROR_WAIT, runtimeStatus: "exited" } });
    expect(tokenOf("wait")).toBeUndefined();
  });

  it("reads only a failed exit, and keeps it through a rebuilt record", () => {
    const write = recorder();
    for (const exitCode of [0, 130]) {
      write({ "t-1": { runtimeStatus: "exited", exitCode } });
      expect(tokenOf("exit"), `exit ${exitCode}`).toBeUndefined();
    }

    write({ "t-1": { ...FAILED_EXIT, restartKey: 2, startedAt: 10 } });
    const first = tokenOf("exit");
    expect(first).toBeDefined();
    // A reconnect replaces the record and stamps a new start without a restart.
    write({ "t-1": { ...FAILED_EXIT, startedAt: 20 } });
    expect(tokenOf("exit")).toBe(first);

    // A restart clears the exit; the next failed exit is another failure.
    write({ "t-1": { restartKey: 3 } });
    write({ "t-1": { ...FAILED_EXIT, restartKey: 3 } });
    expect(tokenOf("exit")).not.toBe(first);
  });

  it("reads a restart error replaced by a later one as a new failure", () => {
    const write = recorder();
    const restartError = (timestamp: number) => ({
      restartError: { message: "cwd gone", timestamp, recoverable: true },
    });
    write({ "t-1": restartError(1) });
    const first = tokenOf("restart");
    write({ "t-1": { ...restartError(1), title: "renamed" } });
    expect(tokenOf("restart")).toBe(first);

    write({ "t-1": restartError(2) });
    expect(tokenOf("restart")).not.toBe(first);
  });

  it("reads a spawn error until it clears, and leaves a reconnect timeout out", () => {
    const write = recorder();
    write({ "t-1": { spawnError: { code: "ENOENT", message: "not found" } } });
    const first = tokenOf("spawn");
    write({ "t-1": { spawnError: { code: "EACCES", message: "refined" } } });
    expect(tokenOf("spawn")).toBe(first);
    write({ "t-1": {} });
    expect(tokenOf("spawn")).toBeUndefined();

    write({ "t-1": { reconnectError: { message: "slow", type: "timeout", timestamp: 1 } } });
    expect(tokenOf("reconnect")).toBeUndefined();
    write({ "t-1": { reconnectError: { message: "gone", type: "not_found", timestamp: 2 } } });
    expect(tokenOf("reconnect")).toBeDefined();
  });

  it("gives every failed submit its own failure, even back to back", () => {
    const { noteSubmitFailure } = usePanelFailureStore.getState();
    noteSubmitFailure("t-1");
    const first = tokenOf("submit");
    noteSubmitFailure("t-1");
    expect(tokenOf("submit")).toBeDefined();
    expect(tokenOf("submit")).not.toBe(first);
  });

  it("keeps a seen failure seen when another one beside it clears", () => {
    const write = recorder();
    const restartError = { message: "cwd gone", timestamp: 1, recoverable: true };
    write({ "t-1": { ...FAILED_EXIT, restartError } });
    usePanelFailureStore
      .getState()
      .markSeen("t-1", { exit: tokenOf("exit")!, restart: tokenOf("restart")! });

    write({ "t-1": FAILED_EXIT });
    const { seen } = usePanelFailureStore.getState();
    expect(seen["t-1"]?.exit).toBe(tokenOf("exit"));
    expect(seen["t-1"]?.restart).toBeUndefined();
  });

  it("writes nothing when no failure changed, and forgets a removed panel", () => {
    const write = recorder();
    write({ "t-1": FAILED_EXIT, "t-2": {} });
    const before = usePanelFailureStore.getState();
    // Nothing failing changed: the store does not write.
    write({ "t-1": FAILED_EXIT, "t-2": { title: "renamed" } });
    expect(usePanelFailureStore.getState()).toBe(before);

    usePanelFailureStore.getState().markSeen("t-1", { exit: tokenOf("exit")! });
    usePanelFailureStore.getState().removePanel("t-1");
    const { occurrences, seen } = usePanelFailureStore.getState();
    expect("t-1" in occurrences).toBe(false);
    expect("t-1" in seen).toBe(false);
  });
});
