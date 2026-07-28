// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { buildKeybindingWhenContext } from "../keybindingWhenContext";
import { usePaletteStore, usePanelStore } from "@/store";
import type { PaletteId } from "@/store/paletteStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

function eventFrom(target: Element | null): KeyboardEvent {
  return { target } as unknown as KeyboardEvent;
}

afterEach(() => {
  usePaletteStore.setState({ activePaletteId: null });
  useFleetArmingStore.setState({ armedIds: new Set<string>() });
  usePanelStore.setState({ panelsById: {} });
  document.body.innerHTML = "";
});

describe("buildKeybindingWhenContext", () => {
  it("reports terminalFocused only for targets inside an xterm host", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const inner = document.createElement("span");
    xterm.appendChild(inner);
    document.body.appendChild(xterm);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    expect(buildKeybindingWhenContext(eventFrom(inner)).terminalFocused).toBe(true);
    expect(buildKeybindingWhenContext(eventFrom(outside)).terminalFocused).toBe(false);
    expect(buildKeybindingWhenContext(eventFrom(null)).terminalFocused).toBe(false);
  });

  it("reports modalOpen from an aria-modal dialog in the DOM", () => {
    expect(buildKeybindingWhenContext(eventFrom(null)).modalOpen).toBe(false);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    expect(buildKeybindingWhenContext(eventFrom(null)).modalOpen).toBe(true);
  });

  it("reports the open palette and its id", () => {
    const closed = buildKeybindingWhenContext(eventFrom(null));
    expect(closed.paletteOpen).toBe(false);
    expect(closed.paletteId).toBe("");

    usePaletteStore.setState({ activePaletteId: "commandPalette" as PaletteId });
    const open = buildKeybindingWhenContext(eventFrom(null));
    expect(open.paletteOpen).toBe(true);
    expect(open.paletteId).toBe("commandPalette");
  });

  it("reports fleetArmed and fleetWaiting from armed panels' agent state", () => {
    const idle = buildKeybindingWhenContext(eventFrom(null));
    expect(idle.fleetArmed).toBe(false);
    expect(idle.fleetWaiting).toBe(false);

    usePanelStore.setState({
      panelsById: {
        "t-1": makeAgent("t-1", { agentState: "working" }),
        "t-2": makeAgent("t-2", { agentState: "waiting" }),
      },
    });

    useFleetArmingStore.setState({ armedIds: new Set(["t-1"]) });
    const armedNotWaiting = buildKeybindingWhenContext(eventFrom(null));
    expect(armedNotWaiting.fleetArmed).toBe(true);
    // t-2 is waiting but not armed — must not count.
    expect(armedNotWaiting.fleetWaiting).toBe(false);

    useFleetArmingStore.setState({ armedIds: new Set(["t-1", "t-2"]) });
    expect(buildKeybindingWhenContext(eventFrom(null)).fleetWaiting).toBe(true);
  });

  it("mirrors sidebar visibility from the macro focus store", () => {
    const { visibility } = useMacroFocusStore.getState();

    useMacroFocusStore.setState({ visibility: { ...visibility, sidebar: false } });
    expect(buildKeybindingWhenContext(eventFrom(null)).sidebarVisible).toBe(false);

    useMacroFocusStore.setState({ visibility: { ...visibility, sidebar: true } });
    expect(buildKeybindingWhenContext(eventFrom(null)).sidebarVisible).toBe(true);
  });
});
