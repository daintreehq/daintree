import { afterEach, describe, expect, it } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { mainViewFocusedAgentId } from "../canopyMainViewFocus";

function focus(id: string | null, panel: Record<string, unknown> = {}) {
  usePanelStore.setState({
    panelsById: (id === null
      ? {}
      : {
          [id]: { id, kind: "terminal", location: "grid", detectedAgentId: "claude", ...panel },
        }) as never,
    focusedId: id,
  });
}

describe("mainViewFocusedAgentId", () => {
  afterEach(() => {
    usePanelStore.setState({ panelsById: {} as never, focusedId: null });
  });

  it("names the focused agent terminal, in the grid or the dock", () => {
    focus("a");
    expect(mainViewFocusedAgentId()).toBe("a");
    focus("a", { location: "dock" });
    expect(mainViewFocusedAgentId()).toBe("a");
  });

  it("names an agent launched there before its detection comes back", () => {
    focus("a", { detectedAgentId: undefined, launchAgentId: "claude" });
    expect(mainViewFocusedAgentId()).toBe("a");
  });

  it("names nothing for no focus, a plain terminal, an agent that has since exited, or a browser", () => {
    focus(null);
    expect(mainViewFocusedAgentId()).toBeNull();
    focus("a", { detectedAgentId: undefined });
    expect(mainViewFocusedAgentId()).toBeNull();
    focus("a", { detectedAgentId: undefined, launchAgentId: "claude", agentState: "exited" });
    expect(mainViewFocusedAgentId()).toBeNull();
    focus("a", { detectedAgentId: undefined, launchAgentId: "claude", everDetectedAgent: true });
    expect(mainViewFocusedAgentId()).toBeNull();
    focus("a", { kind: "browser" });
    expect(mainViewFocusedAgentId()).toBeNull();
    usePanelStore.setState({ panelsById: {} as never, focusedId: "gone" });
    expect(mainViewFocusedAgentId()).toBeNull();
  });

  it("names nothing for an agent in the trash or the background", () => {
    focus("a", { location: "trash" });
    expect(mainViewFocusedAgentId()).toBeNull();
    focus("a", { location: "background" });
    expect(mainViewFocusedAgentId()).toBeNull();
  });
});
