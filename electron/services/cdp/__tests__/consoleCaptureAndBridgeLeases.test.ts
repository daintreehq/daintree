/**
 * The interaction the lease service exists for: the dev-preview console capture
 * and the site preview bridge instrument one guest over one debugger session.
 *
 * Both halves run for real here — the IPC handlers from `webview.ts` and a
 * `SitePreviewBridge` with injected deps — against one fake WebContents whose
 * debugger dispatches events to every listener, because the bug being pinned
 * down is precisely what one consumer's teardown does to the other's stream.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const WEB_CONTENTS_ID = 42;
const MAIN_FRAME_ID = "frame-main";
const MAIN_CONTEXT_ID = 7;
const PANEL_ID = "panel-1";
const ADAPTER_ID = "test.guest";
const PROJECT_ID = "project-1";

class FakeDebugger extends EventEmitter {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  attached = false;
  scriptCounter = 0;
  /** The guest's console buffer, re-delivered by `Runtime.enable` as CDP does. */
  readonly buffer: string[] = [];

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    if (method === "Runtime.enable") {
      for (const text of this.buffer) {
        this.emit("message", {} as Electron.Event, "Runtime.consoleAPICalled", {
          type: "log",
          args: [{ type: "string", value: text }],
          timestamp: 1000,
        });
      }
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: MAIN_FRAME_ID } } };
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      this.scriptCounter += 1;
      return { identifier: `script-${this.scriptCounter}` };
    }
    return {};
  }
  methods(): string[] {
    return this.commands.map((c) => c.method);
  }
}

class FakeWebContents extends EventEmitter {
  readonly id = WEB_CONTENTS_ID;
  readonly debugger = new FakeDebugger();
  readonly hostWebContents = null;
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return "http://localhost:5173/";
  }
}

const guest = new FakeWebContents();

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  webContents: {
    fromId: () => guest,
    getAllWebContents: () => [guest],
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  app: { on: vi.fn() },
}));

vi.mock("../../WebviewDialogService.js", () => ({
  getWebviewDialogService: () => ({
    getPanelId: () => PANEL_ID,
    getPanelKind: () => "dev-preview",
    getWebContentsId: () => WEB_CONTENTS_ID,
    registerPanel: vi.fn(),
    resolveDialog: vi.fn(),
    consumeOAuthSessionStorage: vi.fn().mockResolvedValue([]),
  }),
}));

const consoleRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../../../ipc/utils.js", () => ({
  sendToRenderer: vi.fn(),
  broadcastToRenderer: vi.fn((channel: string, payload: unknown) => {
    if (channel === "webview:console-message") {
      consoleRows.push(payload as Record<string, unknown>);
    }
  }),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: () => () => {},
}));

import { registerWebviewHandlers } from "../../../ipc/handlers/webview.js";
import { SitePreviewBridge } from "../../SitePreviewBridge.js";
import { GUEST_PROTOCOL_VERSION } from "../../sitePreview/guestProtocol.js";
import { __resetCdpLeasesForTests, isCdpDomainEnabled } from "../WebContentsCdpService.js";
import type { SitePreviewPushPayload } from "../../../../shared/types/ipc/sitePreview.js";
import type { HandlerDependencies } from "../../../ipc/types.js";

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([ch]: string[]) => ch === channel);
  if (!call) throw new Error(`Handler not registered for ${channel}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return call[1] as (...args: any[]) => Promise<any>;
}

function makeBridge(pushed: SitePreviewPushPayload[]): SitePreviewBridge {
  return new SitePreviewBridge({
    push: (payload) => pushed.push(payload),
    listGuests: () => [
      { webContentsId: WEB_CONTENTS_ID, panelId: PANEL_ID, projectId: PROJECT_ID, url: null },
    ],
    getWebContents: () => guest as unknown as Electron.WebContents,
    resolveWebContentsId: () => WEB_CONTENTS_ID,
    getPanelKind: () => "dev-preview",
    resolveGuestProject: () => PROJECT_ID,
    newSessionId: () => "session-1",
    newBindingName: () => "__binding",
    // The host resolves the runtime; this stands in for its adapter registry.
    resolveGuestAdapter: (adapterId) => ({ id: adapterId, pluginId: "test.plugin" }),
    loadGuestAdapterSource: async () => "",
  });
}

function emit(method: string, params: unknown): void {
  guest.debugger.emit("message", {} as Electron.Event, method, params);
}

function callBinding(sequence: number): void {
  emit("Runtime.bindingCalled", {
    name: "__binding",
    executionContextId: MAIN_CONTEXT_ID,
    payload: JSON.stringify({
      protocolVersion: GUEST_PROTOCOL_VERSION,
      sessionId: "session-1",
      documentEpoch: 0,
      sequence,
      event: { type: "mappingRevisionSeen", revision: `rev-${sequence}` },
    }),
  });
}

/** One console call, appended to the guest's buffer as the real thing would be. */
function logLine(text: string): void {
  guest.debugger.buffer.push(text);
  emit("Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: text }],
    timestamp: 1000,
  });
}

describe("console capture and the site preview bridge on one guest", () => {
  const deps = { mainWindow: null } as unknown as HandlerDependencies;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    __resetCdpLeasesForTests();
    ipcMainMock.handle.mockClear();
    guest.debugger.commands.length = 0;
    guest.debugger.buffer.length = 0;
    consoleRows.length = 0;
    cleanup = registerWebviewHandlers(deps);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetCdpLeasesForTests();
  });

  it("keeps the binding's Runtime stream alive across a console pane's stop", async () => {
    const pushed: SitePreviewPushPayload[] = [];
    const bridge = makeBridge(pushed);
    await bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    emit("Runtime.executionContextCreated", {
      context: { id: MAIN_CONTEXT_ID, auxData: { isDefault: true, frameId: MAIN_FRAME_ID } },
    });

    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    await getHandler("webview:stop-console-capture")(null, WEB_CONTENTS_ID, "pane-1");

    // The console pane's departure used to disable Runtime under the binding,
    // which then sat bound and deaf.
    expect(guest.debugger.methods()).not.toContain("Runtime.disable");
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);

    pushed.length = 0;
    callBinding(0);
    expect(pushed.filter((p) => p.kind === "guest-event")).toHaveLength(1);

    // Log was only ever the console capture's, so that one does come off.
    expect(guest.debugger.methods()).toContain("Log.disable");

    await bridge.disposeAll();
    expect(guest.debugger.methods()).toContain("Runtime.disable");
  });

  it("enables Runtime once for both consumers and never replays twice", async () => {
    const pushed: SitePreviewPushPayload[] = [];
    const bridge = makeBridge(pushed);

    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("before the bind");
    await bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    // One enable, so one replay: the bridge's old disable/enable cycle would
    // have re-delivered every buffered row for the console pane to reconcile.
    expect(guest.debugger.methods().filter((m) => m === "Runtime.enable")).toHaveLength(1);
    expect(guest.debugger.methods()).not.toContain("Runtime.disable");
    expect(consoleRows.map((row) => row.summaryText)).toEqual(["before the bind"]);

    await bridge.disposeAll();
  });

  it("does not re-deliver a shown row when the domain is finally re-enabled", async () => {
    // The watermark is a position in the guest's append-only buffer, so an event
    // seen while no pane was capturing still has to count. If it did not, the
    // replay that a genuine `Runtime.enable` triggers would resume one event
    // short and duplicate a row the renderer still displays.
    const pushed: SitePreviewPushPayload[] = [];
    const bridge = makeBridge(pushed);
    await bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("shown first");
    await getHandler("webview:stop-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("logged while nothing was listening");
    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("shown second");
    await getHandler("webview:stop-console-capture")(null, WEB_CONTENTS_ID, "pane-1");

    // The bridge lets Runtime go, so the next start really does enable it and
    // CDP replays the whole buffer.
    await bridge.disposeAll();
    expect(guest.debugger.methods()).toContain("Runtime.disable");
    consoleRows.length = 0;
    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");

    expect(consoleRows.map((row) => row.summaryText)).toEqual([]);
  });

  it("counts but does not emit console traffic that arrives while no pane is capturing", async () => {
    const pushed: SitePreviewPushPayload[] = [];
    const bridge = makeBridge(pushed);
    await bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("while capturing");
    await getHandler("webview:stop-console-capture")(null, WEB_CONTENTS_ID, "pane-1");

    // Runtime stays on for the binding, so the console listener is still being
    // called. With no pane there is no row to emit, but the event still occupies
    // a position in the guest's buffer and has to be counted — otherwise a later
    // enable's replay resumes short and re-delivers a row the renderer has.
    logLine("while stopped");
    await getHandler("webview:start-console-capture")(null, WEB_CONTENTS_ID, "pane-1");
    logLine("after restarting");

    expect(consoleRows.map((row) => row.summaryText)).toEqual([
      "while capturing",
      "after restarting",
    ]);

    await bridge.disposeAll();
  });
});
