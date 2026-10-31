// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { buildKeybindingWhenContext } from "../keybindingWhenContext";
import { PANE_DIALOG_ATTR } from "@/lib/paneDialog";
import { usePaletteStore, usePanelStore } from "@/store";
import type { PaletteId } from "@/store/paletteStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import type { VoiceInputStatus } from "@shared/types/voice";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";
import { evaluate, parse } from "@shared/utils/whenClause";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import type { Project } from "@shared/types/project";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";
import { claimWaitingSend } from "@/services/voiceDraftSend";
import { buildDefaultKeybindings } from "@shared/config/defaultKeybindings";

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
  useVoiceRecordingStore.setState({ status: "idle", pendingTarget: null, sessionElsewhere: null });
  usePaletteStore.setState({ activePaletteId: null });
  useFleetArmingStore.setState({ armedIds: new Set<string>() });
  usePanelStore.setState({ panelsById: {} });
  usePluginContextKeyStore.setState({ keysByPlugin: {}, whenContext: {} });
  useProjectStore.setState({ currentProject: null });
  _resetProjectPresentationStoreForTest();
  useSidebarViewStore.setState({ activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID });
  document.body.innerHTML = "";
});

function repoProject(gitBacked: boolean): Project {
  return { id: "a".repeat(64), name: "Repo", path: "/repo", emoji: "", lastOpened: 0, gitBacked };
}

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

  it("reports dictationActive from arming until the session is over, here or in another view", () => {
    const statuses: [VoiceInputStatus, boolean][] = [
      ["idle", false],
      ["arming", true],
      ["connecting", true],
      ["recording", true],
      ["paused", true],
      ["reconnecting", true],
      ["finishing", true],
      ["error", false],
    ];
    for (const [status, active] of statuses) {
      useVoiceRecordingStore.setState({ status });
      expect(buildKeybindingWhenContext(eventFrom(null)).dictationActive).toBe(active);
    }

    useVoiceRecordingStore.setState({ status: "idle", pendingTarget: { panelId: "p1" } });
    expect(buildKeybindingWhenContext(eventFrom(null)).dictationActive).toBe(true);

    useVoiceRecordingStore.setState({
      pendingTarget: null,
      sessionElsewhere: {
        sessionId: "s1",
        hostId: LOCAL_HOST_ID,
        projectId: "proj-2",
        projectName: "Other",
        details: null,
      },
    });
    expect(buildKeybindingWhenContext(eventFrom(null)).dictationActive).toBe(true);
  });

  // #15705: the stop-and-send key, pressed again, sends a waiting send it started.
  it("reports voiceSendWaiting only while a send the stop-and-send key started waits", () => {
    const waiting = () => buildKeybindingWhenContext(eventFrom(null)).voiceSendWaiting;
    const releaseEnter = claimWaitingSend("enter-panel", new Set(["s0"]));
    expect(waiting()).toBe(false);

    const release = claimWaitingSend("key-panel", new Set(["s1"]), () => {});
    expect(waiting()).toBe(true);

    release();
    releaseEnter();
    expect(waiting()).toBe(false);
  });

  it("holds the macOS stop-and-send key while a send it started waits, with dictation over", () => {
    const when = buildDefaultKeybindings(false).find(
      (binding) => binding.actionId === "voiceInput.stopAndSend"
    )!.when!;
    const holds = () => evaluate(parse(when), buildKeybindingWhenContext(eventFrom(null)));
    expect(holds()).toBe(false);

    const release = claimWaitingSend("key-panel", new Set(["s1"]), () => {});
    expect(holds()).toBe(true);
    release();
    expect(holds()).toBe(false);
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

  it("reports modalOpen from a destructive alertdialog, so a !modalOpen binding stands down", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    const ctx = buildKeybindingWhenContext(eventFrom(null));
    expect(ctx.modalOpen).toBe(true);
    expect(evaluate(parse("!textInputFocused && !modalOpen"), ctx)).toBe(false);
  });

  // A page's dialog blocks only its own pane (#15037): a key typed into it
  // sees a modal, a key anywhere else doesn't.
  it("reports modalOpen for a page dialog only for keys inside it", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute(PANE_DIALOG_ATTR, "");
    const ok = document.createElement("button");
    dialog.appendChild(ok);
    const elsewhere = document.createElement("button");
    document.body.append(dialog, elsewhere);

    expect(buildKeybindingWhenContext(eventFrom(ok)).modalOpen).toBe(true);
    expect(buildKeybindingWhenContext(eventFrom(elsewhere)).modalOpen).toBe(false);
    expect(buildKeybindingWhenContext(eventFrom(null)).modalOpen).toBe(false);
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

  it("reports this project's presentation profile, one key per feature", () => {
    const project = repoProject(true);
    useProjectStore.setState({ currentProject: project });
    const holds = (when: string) =>
      evaluate(parse(when), buildKeybindingWhenContext(eventFrom(null)));

    // Until main answers, the default: what the toolbar drew before profiles.
    expect(holds("presentationForgeStats == 'shown'")).toBe(true);

    useProjectPresentationStore.setState({
      loaded: true,
      projectId: project.id,
      levels: { forgeStats: "demoted" },
    });
    expect(holds("presentationForgeStats == 'demoted'")).toBe(true);

    // A profile main sent for some other project never applies here.
    useProjectPresentationStore.setState({ projectId: "b".repeat(64) });
    expect(holds("presentationForgeStats == 'shown'")).toBe(true);
  });

  it("hides forge stats by default in a folder without a repository", () => {
    useProjectStore.setState({
      currentProject: repoProject(false),
    });
    expect(buildKeybindingWhenContext(eventFrom(null)).presentationForgeStats).toBe("hidden");
  });

  it("carries the project facts every plugin chrome `when` sees", () => {
    const holds = (when: string) =>
      evaluate(parse(when), buildKeybindingWhenContext(eventFrom(null)));
    expect(holds("workspaceKind || isGitBacked")).toBe(false);
    expect(holds("activeSidebarView == 'worktrees'")).toBe(true);

    useProjectStore.setState({ currentProject: repoProject(true) });
    useSidebarViewStore.getState().setActiveSidebarView("acme.beads.board");
    expect(
      holds("isGitBacked && workspaceKind == 'project' && activeSidebarView == 'acme.beads.board'")
    ).toBe(true);
  });
});
