import { beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_PANEL_TOOLBAR_TEXT_MAX } from "@shared/types/plugin";
import { normalizeToolbarItemState, usePluginPanelToolbarStore } from "../pluginPanelToolbarStore";

const KEY = "acme.ledger.refresh-quotes";

function statesOf(panelId: string) {
  return usePluginPanelToolbarStore.getState().statesByPanelId[panelId];
}

describe("pluginPanelToolbarStore", () => {
  beforeEach(() => {
    usePluginPanelToolbarStore.setState({ statesByPanelId: {} });
  });

  it("keeps each button's state per panel and replaces it on the next call", () => {
    const { setItemState } = usePluginPanelToolbarStore.getState();
    setItemState("p1", KEY, { busy: true, text: "Fetching" });
    setItemState("p2", KEY, { disabled: true });
    setItemState("p1", KEY, { text: "2 prices kept from cache", tone: "warning" });

    expect(statesOf("p1")).toEqual({
      [KEY]: { text: "2 prices kept from cache", tone: "warning" },
    });
    expect(statesOf("p2")).toEqual({ [KEY]: { disabled: true } });
  });

  it("resets a button on null and drops the panel once nothing is left", () => {
    const { setItemState } = usePluginPanelToolbarStore.getState();
    setItemState("p1", KEY, { busy: true });
    setItemState("p1", "acme.ledger.export", { disabled: true });

    setItemState("p1", KEY, null);
    expect(statesOf("p1")).toEqual({ "acme.ledger.export": { disabled: true } });

    setItemState("p1", "acme.ledger.export", null);
    expect(statesOf("p1")).toBeUndefined();
  });

  it("keeps the same snapshot when a call changes nothing", () => {
    const { setItemState } = usePluginPanelToolbarStore.getState();
    setItemState("p1", KEY, { busy: true, updatedAt: 1_000 });
    const before = usePluginPanelToolbarStore.getState().statesByPanelId;

    setItemState("p1", KEY, { busy: true, updatedAt: 1_000 });
    setItemState("p1", "acme.ledger.never-set", null);

    expect(usePluginPanelToolbarStore.getState().statesByPanelId).toBe(before);
  });

  it("clears one panel and leaves the others", () => {
    const { setItemState, clearPanel } = usePluginPanelToolbarStore.getState();
    setItemState("p1", KEY, { busy: true });
    setItemState("p2", KEY, { busy: true });

    clearPanel("p1");

    expect(statesOf("p1")).toBeUndefined();
    expect(statesOf("p2")).toEqual({ [KEY]: { busy: true } });
  });
});

describe("normalizeToolbarItemState", () => {
  it("cuts text and tooltip to the limit", () => {
    const long = "x".repeat(PLUGIN_PANEL_TOOLBAR_TEXT_MAX + 40);
    const state = normalizeToolbarItemState({ text: long, tooltip: long });

    expect(state?.text?.length).toBe(PLUGIN_PANEL_TOOLBAR_TEXT_MAX);
    expect(state?.tooltip?.length).toBe(PLUGIN_PANEL_TOOLBAR_TEXT_MAX);
  });

  it("reads updatedAt as epoch ms or an ISO string", () => {
    expect(normalizeToolbarItemState({ updatedAt: 1_700_000_000_000 })?.updatedAt).toBe(
      1_700_000_000_000
    );
    expect(normalizeToolbarItemState({ updatedAt: "2026-10-01T14:02:00.000Z" })?.updatedAt).toBe(
      Date.parse("2026-10-01T14:02:00.000Z")
    );
  });

  it("drops fields of the wrong shape and keeps the rest", () => {
    const state = normalizeToolbarItemState({
      busy: "yes",
      disabled: true,
      tone: "success",
      text: 42,
      updatedAt: "not a date",
      staleAfterMs: -5,
      tooltip: "   ",
    });

    expect(state).toEqual({ disabled: true });
  });

  it("treats a state with nothing to draw as a reset", () => {
    expect(normalizeToolbarItemState({ busy: false, disabled: false })).toBeNull();
    expect(normalizeToolbarItemState(null)).toBeNull();
    expect(normalizeToolbarItemState("busy")).toBeNull();
  });
});
