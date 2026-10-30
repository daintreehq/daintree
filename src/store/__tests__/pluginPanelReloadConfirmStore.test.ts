import { beforeEach, describe, expect, it } from "vitest";
import { usePluginPanelReloadConfirmStore } from "../pluginPanelReloadConfirmStore";

const store = () => usePluginPanelReloadConfirmStore.getState();

beforeEach(() => {
  usePluginPanelReloadConfirmStore.setState({ pending: null, approvedPanelId: null });
});

describe("pluginPanelReloadConfirmStore (#15236)", () => {
  it("keeps the first panel's question when another panel asks while it waits", () => {
    expect(store().request({ panelId: "a", panelTitle: "A" })).toBe(true);
    expect(store().request({ panelId: "b", panelTitle: "B" })).toBe(false);

    expect(store().pending).toEqual({ panelId: "a", panelTitle: "A" });
  });

  it("takes a repeat request for the waiting panel", () => {
    store().request({ panelId: "a", panelTitle: "A" });

    expect(store().request({ panelId: "a", panelTitle: "A renamed" })).toBe(true);
    expect(store().pending).toEqual({ panelId: "a", panelTitle: "A renamed" });
  });

  it("stages the next panel once the waiting question is answered either way", () => {
    store().request({ panelId: "a", panelTitle: "A" });
    store().clear();
    expect(store().request({ panelId: "b", panelTitle: "B" })).toBe(true);

    store().approve("b");
    expect(store().request({ panelId: "c", panelTitle: "C" })).toBe(true);
    expect(store().pending?.panelId).toBe("c");
  });
});
