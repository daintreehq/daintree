import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
}));

import { SitePreviewBridge } from "../SitePreviewBridge.js";
import { isCdpDomainEnabled } from "../cdp/WebContentsCdpService.js";
import { __resetCdpLeasesForTests, acquireCdpLease } from "../cdp/WebContentsCdpService.js";
import { GUEST_PROTOCOL_VERSION } from "../sitePreview/guestProtocol.js";
import { GUEST_RUNTIME_GLOBAL } from "../sitePreview/guestRuntime.js";
import type { SitePreviewPushPayload } from "../../../shared/types/ipc/sitePreview.js";

const PANEL_ID = "panel-1";
const ADAPTER_ID = "test.guest";
const PLUGIN_ID = "test.plugin";
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
  /** What the guest currently shows; a test navigates by setting it before `did-navigate`. */
  url = "http://localhost:5173/";
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
}

function makeHarness(
  overrides: {
    guestProject?: string | null;
    panelKind?: string;
    adapterOrigins?: "local-preview" | "any";
  } = {}
) {
  const wc = new FakeWebContents();
  const pushed: SitePreviewPushPayload[] = [];
  let sessionCounter = 0;
  // Stands in for the host's guest-adapter registry: the bridge never sees a
  // caller-supplied body, so a test that wants one registers it here.
  const adapterBodies = new Map<string, string>([[ADAPTER_ID, ""]]);
  const adapterLoad: {
    fails: boolean;
    gate: Promise<void> | null;
    /** Called when a load starts, so a test can wait for the read to be in flight. */
    onEnter: (() => void) | null;
  } = { fails: false, gate: null, onEnter: null };
  // The owning plugin's lifecycle, which a test can switch off mid-flight.
  const pluginEnabled = { value: true };
  const bridge = new SitePreviewBridge({
    push: (payload) => pushed.push(payload),
    isPluginEnabled: async () => pluginEnabled.value,
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
    resolveGuestAdapter: (adapterId) =>
      adapterBodies.has(adapterId)
        ? {
            id: adapterId,
            pluginId: PLUGIN_ID,
            ...(overrides.adapterOrigins ? { origins: overrides.adapterOrigins } : {}),
          }
        : null,
    loadGuestAdapterSource: async (adapterId) => {
      adapterLoad.onEnter?.();
      if (adapterLoad.gate) await adapterLoad.gate;
      if (adapterLoad.fails) throw new Error("asset missing");
      return adapterBodies.get(adapterId) ?? "";
    },
  });
  return { bridge, wc, pushed, adapterBodies, adapterLoad, pluginEnabled };
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
    // Every harness reuses the guest's id, so a lease entry left behind by a
    // previous test would hand the next one the retired debugger session.
    __resetCdpLeasesForTests();
    harness = makeHarness();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  it("enables the Page domain before installing the new-document script", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
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

  it("refuses a bind that names a runtime the host never registered", async () => {
    await expect(
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: "not.registered",
        mode: "browse",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Nothing was attached or installed on the guest's behalf.
    expect(harness.wc.debugger.methods()).toEqual([]);
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBeNull();
  });

  it("leaves the live binding alone when the adapter's body cannot be read", async () => {
    const first = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    harness.adapterLoad.fails = true;

    await expect(
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "browse",
      })
    ).rejects.toThrow(/asset missing/);

    // A failed rebind must not have torn down the session that still works.
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).not.toBeNull();
  });

  it("registers no binding when the bridge shuts down while the body is loading", async () => {
    let release: (() => void) | null = null;
    harness.adapterLoad.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      harness.adapterLoad.onEnter = resolve;
    });

    const bind = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    // The read is the first await a bind performs, so a shutdown can finish
    // walking the bindings map before this one is ever in it. Wait for the
    // read to be in flight: a shutdown before the bind even runs proves nothing.
    await entered;
    await harness.bridge.disposeAll();
    release!();

    await expect(bind).rejects.toThrow(/shutting down/);
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBeNull();
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("registers no successor when the bridge shuts down while a rebind tears down its predecessor", async () => {
    const first = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    // Hold the predecessor's teardown on its last CDP call so a shutdown can
    // land while the successor is still waiting to be inserted.
    let release!: () => void;
    harness.wc.debugger.gates.set(
      "Runtime.removeBinding",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const rebind = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    });
    const shutdown = harness.bridge.disposeAll();
    harness.wc.debugger.gates.delete("Runtime.removeBinding");
    release();
    await shutdown;

    await expect(rebind).rejects.toThrow(/shutting down/);
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBeNull();
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("bakes the session, epoch and binding name into the installed source", async () => {
    harness.adapterBodies.set(ADAPTER_ID, "api.post({ type: 'x' });");
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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

  it("forwards an event type it has never heard of, verbatim", async () => {
    // The host owns the envelope, not the payload: an adapter for another
    // framework emits its own events and core is not a party to them. Only the
    // lifecycle event it acts on has a shape here.
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.pushed.length = 0;

    callBinding(
      harness.wc,
      envelope({ event: { type: "ariaTreeChanged", roles: ["main"], depth: 3 } })
    );

    const [pushed] = harness.pushed;
    expect(pushed).toMatchObject({
      kind: "guest-event",
      event: { type: "ariaTreeChanged", roles: ["main"], depth: 3 },
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(0);
    // An unknown event says nothing about readiness.
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.guestReady).toBe(false);
  });

  it("drops an event with no usable type, and a malformed lifecycle event", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.pushed.length = 0;

    callBinding(harness.wc, envelope({ event: { revision: "rev-1" } }));
    callBinding(harness.wc, envelope({ sequence: 1, event: { type: "" } }));
    // Readiness is the one payload fact the host acts on, so a `documentReady`
    // missing the fields that describe the document must not be admitted as an
    // opaque event and still flip the flag.
    callBinding(harness.wc, envelope({ sequence: 2, event: { type: "documentReady" } }));

    expect(harness.pushed).toHaveLength(0);
    const state = harness.bridge.getState(PROJECT_ID, "session-1");
    expect(state?.droppedMessages).toBe(3);
    expect(state?.guestReady).toBe(false);
  });

  it("drops mismatched-session, replayed, stale, wrong-version, sub-frame and oversized traffic", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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

  it("withholds the runtime from a page outside the adapter's origins, and keeps the binding", async () => {
    harness.wc.url = "https://example.com/pricing";
    const state = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    expect(state.suspended).toBe(true);
    const methods = harness.wc.debugger.methods();
    expect(methods).not.toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(methods).not.toContain("Runtime.evaluate");
    expect(harness.pushed).toContainEqual({
      kind: "origin-policy",
      sessionId: "session-1",
      projectId: PROJECT_ID,
      documentEpoch: 0,
      suspended: true,
    });
    expect(harness.pushed.some((p) => p.kind === "detached")).toBe(false);
    expect(
      harness.bridge.listCandidates(PROJECT_ID).find((c) => c.panelId === PANEL_ID)?.boundSessionId
    ).toBe("session-1");
  });

  it("suspends when the preview leaves the local origin and resumes on the way back", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    announceContexts(harness.wc);
    const installsBefore = harness.wc.debugger.commands.filter(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
    ).length;

    harness.wc.url = "https://accounts.example.com/login";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.pushed).toContainEqual({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        documentEpoch: 1,
        suspended: true,
      });
    });
    // The previous document's script has already run in this one, so the
    // removal is threefold: the script, the binding, and the runtime itself —
    // disposed by the install id it was given, as on teardown.
    const methods = harness.wc.debugger.methods();
    expect(methods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(methods).toContain("Runtime.removeBinding");
    const disposals = harness.wc.debugger.commands.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String(c.params?.expression).includes("api.installId !== ")
    );
    expect(disposals).toHaveLength(1);
    expect(
      harness.wc.debugger.commands.filter(
        (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
      ).length
    ).toBe(installsBefore);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);

    // Traffic from the excluded document is ignored, not counted as abuse.
    callBinding(harness.wc, envelope({ documentEpoch: 1, event: { type: "documentReady" } }));
    expect(harness.pushed.some((p) => p.kind === "guest-event")).toBe(false);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(0);

    harness.wc.url = "http://127.0.0.1:5173/";
    // The runtime reports `documentReady` from inside the install's evaluate,
    // before that call returns. Held here so the readiness lands while the
    // resumed install is still in flight: it must not be ignored as suspended
    // traffic.
    let releaseEvaluate: () => void = () => {};
    harness.wc.debugger.gates.set(
      "Runtime.evaluate",
      new Promise<void>((resolve) => {
        releaseEvaluate = resolve;
      })
    );
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.pushed).toContainEqual({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        documentEpoch: 2,
        suspended: false,
      });
    });
    await vi.waitFor(() => {
      const installs = harness.wc.debugger.commands.filter(
        (c) => c.method === "Page.addScriptToEvaluateOnNewDocument"
      );
      expect(installs.length).toBe(installsBefore + 1);
      expect(String(installs.at(-1)?.params?.source)).toContain("DOCUMENT_EPOCH = 2");
    });
    callBinding(
      harness.wc,
      envelope({
        documentEpoch: 2,
        event: {
          type: "documentReady",
          routeId: "/",
          url: "http://127.0.0.1:5173/",
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
      })
    );
    releaseEvaluate();
    harness.wc.debugger.gates.delete("Runtime.evaluate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.guestReady).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(false);
  });

  it("withholds the runtime from a document that arrived while the install was in flight", async () => {
    // The bind's install is past its policy check and waiting on CDP when the
    // page leaves for a foreign origin. That install must not evaluate into the
    // foreign document, and the reinstall the navigation queued must remove the
    // script it registered.
    let releaseAddBinding: () => void = () => {};
    harness.wc.debugger.gates.set(
      "Runtime.addBinding",
      new Promise<void>((resolve) => {
        releaseAddBinding = resolve;
      })
    );
    const bound = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Runtime.addBinding");
    });
    harness.wc.url = "https://example.com/";
    harness.wc.emit("did-navigate");
    releaseAddBinding();
    harness.wc.debugger.gates.delete("Runtime.addBinding");
    await bound;
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    // The only evaluate allowed into that document is the disposal the
    // suspension sends; the runtime itself never goes in.
    const evaluated = harness.wc.debugger.commands
      .filter((c) => c.method === "Runtime.evaluate")
      .map((c) => String(c.params?.expression));
    expect(evaluated.some((source) => source.includes("DOCUMENT_EPOCH"))).toBe(false);
    const methods = harness.wc.debugger.methods();
    expect(methods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(harness.wc.debugger.commands.at(-1)?.method).not.toBe(
      "Page.addScriptToEvaluateOnNewDocument"
    );
  });

  it("installs anywhere for an adapter declared for any origin", async () => {
    harness = makeHarness({ adapterOrigins: "any" });
    harness.wc.url = "https://example.com/";
    const state = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    expect(state.suspended).toBe(false);
    expect(harness.wc.debugger.methods()).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(harness.pushed.some((p) => p.kind === "origin-policy")).toBe(false);
  });

  it("refuses a panel embedded by another project's view", async () => {
    const foreign = makeHarness({ guestProject: "project-2" });
    await expect(
      foreign.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
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
        adapterId: ADAPTER_ID,
        mode: "browse",
      })
    ).rejects.toThrow(/not a dev preview/i);
  });

  it("scopes enumeration and state reads to the asking project", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    const second = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    expect(second.sessionId).toBe("session-2");
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    expect(harness.pushed.some((p) => p.kind === "detached" && p.reason === "rebound")).toBe(true);
  });

  it("reads the contexts from the shared snapshot without cycling the Runtime domain", async () => {
    // The webview console capture enables Runtime for dev-preview panels too,
    // and only the first enable replays the contexts. The bridge used to force
    // a second replay with a disable/enable cycle; it now reads the snapshot the
    // lease service keeps, so the domain is enabled once and never cycled.
    const consoleLease = await acquireCdpLease(harness.wc as unknown as Electron.WebContents, [
      "Runtime",
    ]);
    announceContexts(harness.wc);

    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    const methods = harness.wc.debugger.methods();
    expect(methods.filter((m) => m === "Runtime.enable").length).toBe(1);
    expect(methods).not.toContain("Runtime.disable");

    // The snapshot predates the binding, and the main-frame filter still works
    // off it: the main frame's context is trusted, a sub-frame's is not.
    callBinding(harness.wc, envelope());
    expect(harness.pushed.filter((p) => p.kind === "guest-event")).toHaveLength(1);
    harness.pushed.length = 0;
    callBinding(harness.wc, envelope({ sequence: 1 }), IFRAME_CONTEXT_ID);
    expect(harness.pushed.filter((p) => p.kind === "guest-event")).toHaveLength(0);

    await consoleLease.release();
  });

  it("degrades to unfiltered when nothing has announced a context", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    // A guest whose contexts never arrived must not go silent — the filter is
    // defence in depth, not the load-bearing boundary.
    callBinding(harness.wc, envelope(), 12345);
    expect(harness.pushed.filter((p) => p.kind === "guest-event")).toHaveLength(1);
  });

  it("installs one runtime when two binds for the same panel race", async () => {
    const [first, second] = await Promise.all([
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "browse",
      }),
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "browse",
      }),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBe(second.sessionId);
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    // One live listener set, not two: the superseded binding removed its own.
    // The second message listener is the CDP lease service's context tracker,
    // one per guest however many consumers it serves.
    expect(harness.wc.debugger.listenerCount("message")).toBe(2);
    expect(harness.wc.listenerCount("did-navigate")).toBe(1);
  });

  it("gives each install a higher id than the runtime it replaces", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
        adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
        adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    const [, rebound] = await Promise.all([
      harness.bridge.detach(PROJECT_ID, "session-1"),
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "browse",
      }),
    ]);

    expect(harness.bridge.getState(PROJECT_ID, rebound.sessionId)).not.toBeNull();
    expect(harness.bridge.listCandidates(PROJECT_ID)[0]?.boundSessionId).toBe(rebound.sessionId);
    // The bridge's own listener plus the lease service's context tracker.
    expect(harness.wc.debugger.listenerCount("message")).toBe(2);
  });

  it("refuses new binds once the bridge is shutting down", async () => {
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    const shutdown = harness.bridge.disposeAll();
    const late = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });

    await shutdown;
    await expect(late).rejects.toThrow(/shutting down/);
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("releases a lease acquired after teardown stopped waiting for it", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      harness.wc.debugger.gates.set(
        "Page.enable",
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      const bound = harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "browse",
      });
      await vi.waitFor(() => {
        expect(harness.wc.debugger.methods()).toContain("Page.enable");
      });

      // Teardown gives the queued install a bounded wait and moves on.
      const shutdown = harness.bridge.disposeAll();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;

      harness.wc.debugger.gates.delete("Page.enable");
      release();
      await bound.catch(() => undefined);
      await vi.runAllTimersAsync();

      // The acquisition that outran the wait must let go: nothing owns the
      // binding any more, so nothing may hold the domains on for it.
      expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(false);
      expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds no binding when teardown stopped waiting during the frame-tree read", async () => {
    vi.useFakeTimers();
    try {
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
        adapterId: ADAPTER_ID,
        mode: "browse",
      });
      await vi.waitFor(() => {
        expect(harness.wc.debugger.methods()).toContain("Page.getFrameTree");
      });
      const shutdown = harness.bridge.disposeAll();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;

      harness.wc.debugger.gates.delete("Page.getFrameTree");
      release();
      await bound.catch(() => undefined);
      await vi.runAllTimersAsync();

      // Nothing the resumed install did may outlive the teardown that gave up
      // on it: no binding registered, no script installed.
      expect(harness.wc.debugger.methods()).not.toContain("Runtime.addBinding");
      expect(harness.wc.debugger.methods()).not.toContain("Page.addScriptToEvaluateOnNewDocument");
      expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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
      adapterId: ADAPTER_ID,
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

describe("SitePreviewBridge owner lifecycle", () => {
  it("refuses to bind an adapter whose plugin is not enabled", async () => {
    const harness = makeHarness();
    harness.pluginEnabled.value = false;

    await expect(
      harness.bridge.bind({
        projectId: PROJECT_ID,
        panelId: PANEL_ID,
        adapterId: ADAPTER_ID,
        mode: "select",
      })
    ).rejects.toThrow(/not enabled/);

    // Nothing was read and nothing was installed.
    expect(harness.wc.debugger.methods()).not.toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("refuses when the plugin is disabled while the adapter body is being read", async () => {
    const harness = makeHarness();
    let release: () => void = () => {};
    harness.adapterLoad.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.adapterLoad.onEnter = () => {
      // The disable lands under the read's await — the window the second check
      // exists to close.
      harness.pluginEnabled.value = false;
    };
    const bound = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });
    release();

    await expect(bound).rejects.toThrow(/not enabled/);
    expect(harness.wc.debugger.methods()).not.toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("tears down a live binding when its owning plugin unloads", async () => {
    const harness = makeHarness();
    const state = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });
    expect(harness.bridge.getState(PROJECT_ID, state.sessionId)).not.toBeNull();

    await harness.bridge.disposeForPlugin(PLUGIN_ID);

    expect(harness.bridge.getState(PROJECT_ID, state.sessionId)).toBeNull();
    expect(harness.pushed.some((p) => p.kind === "detached" && p.reason === "owner-disabled")).toBe(
      true
    );
    // The runtime already in the page goes too, not just the registration.
    expect(harness.wc.debugger.methods()).toContain("Page.removeScriptToEvaluateOnNewDocument");
  });

  it("leaves another plugin's bindings alone", async () => {
    const harness = makeHarness();
    const state = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });

    await harness.bridge.disposeForPlugin("some.other.plugin");

    expect(harness.bridge.getState(PROJECT_ID, state.sessionId)).not.toBeNull();
  });
});

describe("SitePreviewBridge disable races a bind", () => {
  it("refuses a bind whose plugin was torn down while it was in flight", async () => {
    // `teardown` removes a binding from the map before awaiting its CDP
    // cleanup, so a `disposeForPlugin` overlapping a bind can walk an empty map
    // and leave the successor behind. The enabled flag is deliberately left
    // TRUE here, so only the generation guard can refuse this.
    const harness = makeHarness();
    let release: () => void = () => {};
    harness.adapterLoad.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.adapterLoad.onEnter = () => {
      void harness.bridge.disposeForPlugin(PLUGIN_ID);
    };

    const bound = harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });
    release();

    await expect(bound).rejects.toThrow(/not enabled/);
    expect(harness.wc.debugger.methods()).not.toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("still binds normally when no teardown intervened", async () => {
    // The guard must not refuse an ordinary bind, including a rebind of the
    // same panel, which tears the predecessor down on purpose.
    const harness = makeHarness();
    const first = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });
    const second = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(harness.bridge.getState(PROJECT_ID, second.sessionId)).not.toBeNull();
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
  });
});

describe("SitePreviewBridge out-of-band ops", () => {
  beforeEach(() => {
    __resetCdpLeasesForTests();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  /** Bind, then navigate somewhere the adapter's policy excludes. */
  async function suspendedHarness() {
    const harness = makeHarness();
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    announceContexts(harness.wc);
    harness.wc.url = "https://accounts.example.com/login";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    return harness;
  }

  function evaluations(harness: ReturnType<typeof makeHarness>): string[] {
    return harness.wc.debugger.commands
      .filter((c) => c.method === "Runtime.evaluate")
      .map((c) => String(c.params?.expression));
  }

  it("evaluates nothing in a document the origin policy excluded", async () => {
    const harness = await suspendedHarness();
    const before = evaluations(harness).length;

    const state = await harness.bridge.setMode(PROJECT_ID, "session-1", "select");
    const found = await harness.bridge.reselect(
      PROJECT_ID,
      "session-1",
      { file: "src/routes/+page.svelte", line: 12, column: 4 },
      0,
      { file: "src/lib/Card.svelte", line: 1, column: 0 },
      "occ-1"
    );
    await harness.bridge.clearSelection(PROJECT_ID, "session-1");
    await harness.bridge.clearHover(PROJECT_ID, "session-1");

    // The mode is still recorded — the next install bakes it in — but nothing
    // was driven in the third-party document, and no source path reached it.
    expect(state.mode).toBe("select");
    expect(found).toBe(false);
    expect(evaluations(harness)).toHaveLength(before);
    expect(evaluations(harness).some((e) => e.includes("+page.svelte"))).toBe(false);
    expect(evaluations(harness).some((e) => e.includes("Card.svelte"))).toBe(false);
  });

  it("carries the mode set while suspended into the resumed install", async () => {
    const harness = await suspendedHarness();
    await harness.bridge.setMode(PROJECT_ID, "session-1", "select");

    harness.wc.url = "http://localhost:5173/";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(false);
    });
    const installed = harness.wc.debugger.commands
      .filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")
      .map((c) => String(c.params?.source));
    expect(installed.at(-1)).toContain('mode: "select"');
  });

  it("drives a live binding, and refuses a location it cannot bound", async () => {
    const harness = makeHarness();
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "select",
    });
    harness.wc.debugger.responses.set("Runtime.evaluate", { result: { value: true } });

    expect(
      await harness.bridge.reselect(PROJECT_ID, "session-1", {
        file: "src/routes/+page.svelte",
        line: 12,
        column: 4,
      })
    ).toBe(true);
    expect(evaluations(harness).some((e) => e.includes("+page.svelte"))).toBe(true);

    const badlyShaped = evaluations(harness).length;
    // Bounded by the IPC schema in production; the bridge refuses to
    // interpolate anything it has not checked itself, whatever path reached it.
    expect(
      await harness.bridge.reselect(PROJECT_ID, "session-1", {
        file: "src/routes/+page.svelte",
        line: Number.NaN,
        column: 4,
      })
    ).toBe(false);
    expect(
      await harness.bridge.reselect(
        PROJECT_ID,
        "session-1",
        { file: "src/routes/+page.svelte", line: 1, column: 0 },
        Number.POSITIVE_INFINITY
      )
    ).toBe(false);
    expect(evaluations(harness)).toHaveLength(badlyShaped);
  });
});

describe("SitePreviewBridge blank documents", () => {
  beforeEach(() => {
    __resetCdpLeasesForTests();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  it("installs on the blank page a preview starts on", async () => {
    const harness = makeHarness();
    harness.wc.url = "about:blank";
    const state = await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    expect(state.suspended).toBe(false);
    expect(harness.wc.debugger.methods()).toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("suspends when a page navigates to about:blank", async () => {
    // A top-level navigation to about:blank inherits the initiator's origin,
    // so the blank allowance ends the moment anything has been committed.
    const harness = makeHarness();
    await harness.bridge.bind({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      adapterId: ADAPTER_ID,
      mode: "browse",
    });
    announceContexts(harness.wc);

    harness.wc.url = "about:blank";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    expect(harness.pushed).toContainEqual({
      kind: "origin-policy",
      sessionId: "session-1",
      projectId: PROJECT_ID,
      documentEpoch: 1,
      suspended: true,
    });
  });
});
