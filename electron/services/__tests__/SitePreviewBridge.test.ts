import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
}));

import { SitePreviewBridge } from "../SitePreviewBridge.js";
import { GUEST_PROTOCOL_VERSION } from "../sitePreview/guestProtocol.js";
import { GUEST_RUNTIME_GLOBAL } from "../sitePreview/guestRuntime.js";
import type { SitePreviewPushPayload } from "../../../shared/types/ipc/sitePreview.js";

const PANEL_ID = "panel-1";
const PROJECT_ID = "project-1";
const WEB_CONTENTS_ID = 42;
const MAIN_FRAME_ID = "frame-main";
const MAIN_CONTEXT_ID = 7;
const IFRAME_CONTEXT_ID = 9;

class FakeDebugger extends EventEmitter {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  attached = false;
  scriptCounter = 0;
  /** Commands that reject, to exercise the teardown and install failure paths. */
  readonly rejects = new Map<string, Error>();
  /** Canned responses, e.g. an evaluate that reports a guest-side exception. */
  readonly responses = new Map<string, unknown>();
  /** Holds a command until the promise settles, to open a race window. */
  readonly gates = new Map<string, Promise<void>>();

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    const gate = this.gates.get(method);
    if (gate) await gate;
    const failure = this.rejects.get(method);
    if (failure) throw failure;
    if (this.responses.has(method)) return this.responses.get(method);
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
  isDestroyed(): boolean {
    return false;
  }
}

function makeHarness(overrides: { guestProject?: string | null; panelKind?: string } = {}) {
  const wc = new FakeWebContents();
  const pushed: SitePreviewPushPayload[] = [];
  let sessionCounter = 0;
  const bridge = new SitePreviewBridge({
    push: (payload) => pushed.push(payload),
    listGuests: () => [
      { webContentsId: WEB_CONTENTS_ID, panelId: PANEL_ID, projectId: PROJECT_ID, url: "http://x" },
      { webContentsId: 99, panelId: "other", projectId: "project-2", url: "http://y" },
    ],
    getWebContents: (id) =>
      id === WEB_CONTENTS_ID ? (wc as unknown as Electron.WebContents) : null,
    resolveWebContentsId: (panelId) => (panelId === PANEL_ID ? WEB_CONTENTS_ID : undefined),
    getPanelKind: () => overrides.panelKind ?? "dev-preview",
    resolveGuestProject: () =>
      overrides.guestProject === undefined ? PROJECT_ID : overrides.guestProject,
    newSessionId: () => `session-${++sessionCounter}`,
    newBindingName: () => "__binding",
  });
  return { bridge, wc, pushed };
}

/** Replay the execution-context announcements CDP makes after `Runtime.enable`. */
function announceContexts(wc: FakeWebContents): void {
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
    context: { id: MAIN_CONTEXT_ID, auxData: { isDefault: true, frameId: MAIN_FRAME_ID } },
  });
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
    context: { id: IFRAME_CONTEXT_ID, auxData: { isDefault: true, frameId: "frame-ad" } },
  });
}

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: GUEST_PROTOCOL_VERSION,
    sessionId: "session-1",
    documentEpoch: 0,
    sequence: 0,
    event: { type: "mappingRevisionSeen", revision: "rev-1" },
    ...over,
  });
}

function callBinding(wc: FakeWebContents, payload: string, contextId = MAIN_CONTEXT_ID): void {
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.bindingCalled", {
    name: "__binding",
    executionContextId: contextId,
    payload,
  });
}

describe("SitePreviewBridge", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("enables the Page domain before installing the new-document script", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "/* runtime */",
      mode: "browse",
    });

    const methods = harness.wc.debugger.methods();
    expect(methods.indexOf("Page.enable")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Page.enable")).toBeLessThan(
      methods.indexOf("Page.addScriptToEvaluateOnNewDocument")
    );
    expect(methods).toContain("Runtime.addBinding");
    // Evaluated into the live document too, so binding does not need a reload.
    expect(methods).toContain("Runtime.evaluate");
  });

  it("bakes the session, epoch and binding name into the installed source", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "api.post({ type: 'x' });",
      mode: "select",
    });

    const added = harness.wc.debugger.commands.find(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    );
    const source = String(added?.params?.source);
    expect(source).toContain('"session-1"');
    expect(source).toContain('"__binding"');
    expect(source).toContain(GUEST_RUNTIME_GLOBAL);
    expect(source).toContain("api.post({ type: 'x' });");
  });

  it("forwards an envelope that matches the binding's expectations", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.pushed.length = 0;

    callBinding(harness.wc, envelope());

    expect(harness.pushed).toHaveLength(1);
    const [event] = harness.pushed;
    expect(event?.kind).toBe("guest-event");
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(0);
  });

  it("drops mismatched-session, replayed, stale, wrong-version, sub-frame and oversized traffic", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    callBinding(harness.wc, envelope({ sequence: 5 }));
    harness.pushed.length = 0;

    // Another session's id, a replayed sequence, a future epoch, a wrong
    // protocol version, an iframe's execution context, and a body over the cap.
    callBinding(harness.wc, envelope({ sessionId: "session-2", sequence: 6 }));
    callBinding(harness.wc, envelope({ sequence: 5 }));
    callBinding(harness.wc, envelope({ sequence: 6, documentEpoch: 1 }));
    callBinding(harness.wc, envelope({ sequence: 6, protocolVersion: 2 }));
    callBinding(harness.wc, envelope({ sequence: 6 }), IFRAME_CONTEXT_ID);
    callBinding(
      harness.wc,
      envelope({
        sequence: 6,
        event: { type: "mappingRevisionSeen", revision: "x".repeat(300_000) },
      })
    );

    expect(harness.pushed).toHaveLength(0);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(6);
    // The accepted watermark did not move, so a legitimate next message lands.
    callBinding(harness.wc, envelope({ sequence: 6 }));
    expect(harness.pushed).toHaveLength(1);
  });

  it("treats the guest's post-navigation sequence reset as new, not replayed", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    callBinding(
      harness.wc,
      envelope({
        sequence: 4,
        event: {
          type: "documentReady",
          routeId: null,
          url: "http://x",
          viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
        },
      })
    );
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.guestReady).toBe(true);

    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.documentEpoch).toBe(1);
    });
    const state = harness.bridge.getState(PROJECT_ID, "session-1");
    expect(state?.guestReady).toBe(false);
    harness.pushed.length = 0;

    // Sequence 0 again — below the previous epoch's watermark, yet current.
    callBinding(harness.wc, envelope({ documentEpoch: 1, sequence: 0 }));
    expect(harness.pushed.filter((p) => p.kind === "guest-event")).toHaveLength(1);

    // The previous epoch's script is still installed until its removal lands;
    // anything it emits describes a document that no longer exists.
    harness.pushed.length = 0;
    callBinding(harness.wc, envelope({ documentEpoch: 0, sequence: 99 }));
    expect(harness.pushed).toHaveLength(0);
  });

  it("reinstalls the runtime with the new epoch on navigation", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    const before = harness.wc.debugger.commands.filter(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    ).length;

    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(
        harness.wc.debugger.commands.filter(
          (c) => c.method === "Page.removeScriptToEvaluateOnNewDocument"
        ).length
      ).toBe(1);
    });

    const installs = harness.wc.debugger.commands.filter(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    );
    expect(installs.length).toBe(before + 1);
    expect(String(installs.at(-1)?.params?.source)).toContain("DOCUMENT_EPOCH = 1");
  });

  it("refuses a panel embedded by another project's view", async () => {
    const foreign = makeHarness({ guestProject: "project-2" });
    await expect(
      foreign.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      })
    ).rejects.toThrow(/different project/i);
  });

  it("refuses a panel that is not a dev preview", async () => {
    const browserPanel = makeHarness({ panelKind: "browser" });
    await expect(
      browserPanel.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      })
    ).rejects.toThrow(/not a dev preview/i);
  });

  it("scopes enumeration and state reads to the asking project", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    const candidates = harness.bridge.listCandidates(PROJECT_ID);
    expect(candidates.map((c) => c.panelId)).toEqual([PANEL_ID]);
    expect(candidates[0]?.boundSessionId).toBe("session-1");
    expect(harness.bridge.listCandidates("project-2").map((c) => c.panelId)).toEqual(["other"]);
    expect(harness.bridge.getState("project-2", "session-1")).toBeNull();
  });

  it("removes the installed runtime and stops forwarding once detached", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.pushed.length = 0;

    await harness.bridge.detach(PROJECT_ID, "session-1");

    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    expect(harness.wc.debugger.methods()).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(harness.pushed.some((p) => p.kind === "detached")).toBe(true);

    harness.pushed.length = 0;
    callBinding(harness.wc, envelope({ sequence: 1 }));
    expect(harness.pushed).toHaveLength(0);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });

  it("supersedes an existing binding when the same panel is bound again", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    const second = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    expect(second.sessionId).toBe("session-2");
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    expect(harness.pushed.some((p) => p.kind === "detached" && p.reason === "rebound")).toBe(true);
  });

  it("forces a context replay when the Runtime domain was already enabled elsewhere", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    // The webview console capture enables Runtime for dev-preview panels, so
    // our own enable replays nothing and the bridge would otherwise never learn
    // which context is the main frame's.
    const methods = harness.wc.debugger.methods();
    expect(methods.filter((m) => m === "Runtime.enable").length).toBe(2);
    expect(methods).toContain("Runtime.disable");

    // With no context knowledge the filter degrades to unfiltered rather than
    // discarding every observation.
    callBinding(harness.wc, envelope(), 12345);
    expect(harness.pushed.filter((p) => p.kind === "guest-event")).toHaveLength(1);
  });

  it("installs one runtime when two binds for the same panel race", async () => {
    const [first, second] = await Promise.all([
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      }),
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      }),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBe(second.sessionId);
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    // One live listener set, not two: the superseded binding removed its own.
    expect(harness.wc.debugger.listenerCount("message")).toBe(1);
    expect(harness.wc.listenerCount("did-navigate")).toBe(1);
  });

  it("gives each install a higher id than the runtime it replaces", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    const installIds = harness.wc.debugger.commands
      .filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")
      .map((c) => Number(/INSTALL_ID = (\d+)/.exec(String(c.params?.source))?.[1]));
    expect(installIds).toHaveLength(2);
    // A rebind restarts the epoch at 0, so the epoch cannot order these — the
    // install id is what lets the incoming runtime displace the outgoing one.
    expect(installIds[1]!).toBeGreaterThan(installIds[0]!);
  });

  it("stops parsing once a flooding guest exhausts its per-second budget", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.pushed.length = 0;

    for (let i = 0; i < 400; i++) callBinding(harness.wc, envelope({ sequence: i }));

    const forwarded = harness.pushed.filter((p) => p.kind === "guest-event").length;
    expect(forwarded).toBeGreaterThan(0);
    // The excess is counted and discarded rather than parsed, so a tight loop in
    // the page cannot set the main process's CPU budget.
    expect(forwarded).toBeLessThan(400);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(400 - forwarded);
  });

  it("fails the bind and removes what it installed when the runtime throws in the guest", async () => {
    harness.wc.debugger.responses.set("Runtime.evaluate", {
      exceptionDetails: { text: "Uncaught TypeError" },
    });

    await expect(
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "throw new TypeError()",
        mode: "browse",
      })
    ).rejects.toThrow(/threw while initialising/);

    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBeNull();
    expect(harness.wc.debugger.methods()).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    expect(harness.pushed.some((p) => p.kind === "detached" && p.reason === "install-failed")).toBe(
      true
    );
  });

  it("still removes the binding when removing the new-document script fails", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    harness.wc.debugger.rejects.set(
      "Page.removeScriptToEvaluateOnNewDocument",
      new Error("something unexpected")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await harness.bridge.detach(PROJECT_ID, "session-1");

    // Removing the binding is what stops CDP delivering guest strings into main,
    // so it must not be skipped because an earlier removal failed.
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    warn.mockRestore();
  });

  it("disposes only the runtime it installed, matched on install id", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    const installed = harness.wc.debugger.commands.find(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    );
    const installId = /INSTALL_ID = (\d+)/.exec(String(installed?.params?.source))?.[1];

    await harness.bridge.detach(PROJECT_ID, "session-1");

    const disposal = harness.wc.debugger.commands
      .filter((c) => c.method === "Runtime.evaluate")
      .at(-1);
    expect(String(disposal?.params?.expression)).toContain(`api.installId !== ${installId}`);
    expect(disposal?.params?.timeout).toBeGreaterThan(0);
  });

  it("tears the binding down when the debugger is detached from a live guest", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    harness.wc.debugger.emit("detach", {} as Electron.Event, "target closed");

    await vi.waitFor(() => {
      expect(
        harness.pushed.some((p) => p.kind === "detached" && p.reason === "debugger-detached")
      ).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });

  it("removes the transport from a guest that keeps sending invalid traffic", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    announceContexts(harness.wc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Wrong session every time: never parsed as an observation, always dropped.
    for (let i = 0; i < 6_000; i++) {
      callBinding(harness.wc, envelope({ sessionId: "forged", sequence: i }));
    }

    await vi.waitFor(() => {
      expect(
        harness.pushed.some((p) => p.kind === "detached" && p.reason === "guest-flooding")
      ).toBe(true);
    });
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    // Log output stays bounded regardless of how much the page sends.
    expect(warn.mock.calls.length).toBeLessThan(5);
    warn.mockRestore();
  });

  it("never trips the flood breaker on drops spread across a long session", async () => {
    vi.useFakeTimers();
    try {
      await harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      });
      announceContexts(harness.wc);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Far more lifetime drops than the threshold, but never many in one window.
      for (let minute = 0; minute < 30; minute++) {
        for (let i = 0; i < 1_000; i++) {
          callBinding(harness.wc, envelope({ sessionId: "stale", sequence: i }));
        }
        vi.advanceTimersByTime(60_000);
      }

      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(30_000);
      expect(harness.pushed.some((p) => p.kind === "detached")).toBe(false);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a detach racing a rebind displace the new binding", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    const [, rebound] = await Promise.all([
      harness.bridge.detach(PROJECT_ID, "session-1"),
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        runtimeSource: "",
        mode: "browse",
      }),
    ]);

    expect(harness.bridge.getState(PROJECT_ID, rebound.sessionId)).not.toBeNull();
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBe(rebound.sessionId);
    expect(harness.wc.debugger.listenerCount("message")).toBe(1);
  });

  it("refuses new binds once the bridge is shutting down", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    const shutdown = harness.bridge.disposeAll();
    const late = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    await shutdown;
    await expect(late).rejects.toThrow(/shutting down/);
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("does not install twice for one epoch when a navigation lands mid-install", async () => {
    // Two installs for the same epoch both start the prelude's sequence at 0,
    // so the host drops the second runtime's messages as replays and the
    // inspector goes silent after an ordinary quick navigation.
    let release!: () => void;
    harness.wc.debugger.gates.set(
      "Page.getFrameTree",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const bound = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Page.getFrameTree");
    });
    harness.wc.emit("did-navigate");
    harness.wc.debugger.gates.delete("Page.getFrameTree");
    release();
    await bound;

    // Uniqueness holds in the window before the queued reinstall runs, so
    // polling on it would pass early. Wait until the navigation's reinstall has
    // actually been processed, then assert once.
    await vi.waitFor(() => {
      expect(harness.pushed.some((p) => p.kind === "epoch-advanced")).toBe(true);
    });
    const installs = harness.wc.debugger.commands.filter(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    );
    const epochs = installs.map(
      (c) => /DOCUMENT_EPOCH = (\d+)/.exec(String(c.params?.source))?.[1]
    );
    expect(epochs.length).toBeGreaterThan(0);
    expect(new Set(epochs).size).toBe(epochs.length);
  });

  it("re-applies a mode switch made while the runtime was still installing", async () => {
    let release!: () => void;
    harness.wc.debugger.gates.set(
      "Page.addScriptToEvaluateOnNewDocument",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const bound = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "select",
    });
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Page.addScriptToEvaluateOnNewDocument");
    });
    await harness.bridge.setMode(PROJECT_ID, "session-1", "browse");
    harness.wc.debugger.gates.delete("Page.addScriptToEvaluateOnNewDocument");
    release();
    await bound;

    // The installed source baked in "select"; without the re-apply the host
    // would report Browse while the page kept intercepting clicks.
    const evaluations = harness.wc.debugger.commands.filter((c) => c.method === "Runtime.evaluate");
    expect(String(evaluations.at(-1)?.params?.expression)).toContain('"browse"');
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.mode).toBe("browse");
  });

  it("detaches when the guest webContents goes away", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      runtimeSource: "",
      mode: "browse",
    });

    harness.wc.emit("destroyed");
    await vi.waitFor(() => {
      expect(
        harness.pushed.some((p) => p.kind === "detached" && p.reason === "guest-destroyed")
      ).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });
});
