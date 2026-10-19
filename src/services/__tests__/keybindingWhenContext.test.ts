// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { buildKeybindingWhenContext } from "../keybindingWhenContext";
import { usePaletteStore, usePanelStore } from "@/store";
import type { PaletteId } from "@/store/paletteStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useCanopyStore } from "@/store/canopyStore";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";
import { evaluate, parse } from "@shared/utils/whenClause";

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
  useCanopyStore.setState({ mode: "unset" });
  usePaletteStore.setState({ activePaletteId: null });
  useFleetArmingStore.setState({ armedIds: new Set<string>() });
  usePanelStore.setState({ panelsById: {} });
  usePluginContextKeyStore.setState({ keysByPlugin: {}, whenContext: {} });
  document.body.innerHTML = "";
});

function seedPluginKeys(keysByPlugin: Parameters<typeof buildPluginWhenContext>[0]): void {
  usePluginContextKeyStore.setState({
    keysByPlugin,
    whenContext: buildPluginWhenContext(keysByPlugin),
  });
}

describe("buildKeybindingWhenContext", () => {
  it("reports canopyHidden only while the user has hidden Canopy", () => {
    for (const [mode, hidden] of [
      ["unset", false],
      ["on", false],
      ["hidden", true],
    ] as const) {
      useCanopyStore.setState({ mode });
      expect(buildKeybindingWhenContext(eventFrom(null)).canopyHidden).toBe(hidden);
    }
  });

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

  it("exposes plugin context keys under their manifest name alongside the built-ins", () => {
    seedPluginKeys({ "digitalfrontier.beads": { needsYou: true, view: "triage" } });
    useCanopyStore.setState({ mode: "hidden" });
    const ctx = buildKeybindingWhenContext(eventFrom(null));
    expect(evaluate(parse("digitalfrontier.beads.needsYou && !textInputFocused"), ctx)).toBe(true);
    expect(evaluate(parse("digitalfrontier.beads.view == 'triage'"), ctx)).toBe(true);
    expect(ctx.canopyHidden).toBe(true);
  });

  it("never lets a plugin namespace replace a built-in key", () => {
    // A lowercase built-in is impossible today, but built-ins win structurally.
    usePluginContextKeyStore.setState({
      keysByPlugin: {},
      whenContext: { canopyHidden: { forged: true }, modalOpen: "yes" },
    });
    const ctx = buildKeybindingWhenContext(eventFrom(null));
    expect(ctx.canopyHidden).toBe(false);
    expect(ctx.modalOpen).toBe(false);
  });

  it("marks a text field or editor as text input, but not a terminal's own textarea", () => {
    document.body.innerHTML = `
      <input id="field" />
      <div id="editor" contenteditable="true"></div>
      <div class="xterm"><textarea id="xterm-input"></textarea></div>
      <button id="button">Go</button>`;
    // jsdom doesn't implement isContentEditable; Chromium sets it for this element.
    Object.defineProperty(document.getElementById("editor"), "isContentEditable", { value: true });
    const ctx = (id: string) => buildKeybindingWhenContext(eventFrom(document.getElementById(id)));
    expect(ctx("field").textInputFocused).toBe(true);
    expect(ctx("editor").textInputFocused).toBe(true);
    expect(ctx("xterm-input").textInputFocused).toBe(false);
    expect(ctx("xterm-input").terminalFocused).toBe(true);
    expect(ctx("button").textInputFocused).toBe(false);
  });
});
