import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [], fromId: () => null },
  app: { getAppPath: () => "/nonexistent", isPackaged: false },
}));

import { SitePreviewBridge } from "../SitePreviewBridge.js";
import { isCdpDomainEnabled } from "../cdp/WebContentsCdpService.js";
import { __resetCdpLeasesForTests, acquireCdpLease } from "../cdp/WebContentsCdpService.js";
import { ELEMENT_PICKER_PROTOCOL_VERSION } from "../../../shared/elementPicker/protocol.js";
import type { ElementPickerPushPayload, ElementPickerSink } from "../elementPicker/types.js";
import type { SitePreviewMode } from "../../../shared/types/ipc/sitePreview.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";

const PANEL_ID = "panel-1";
const PROJECT_ID = "project-1";
const WEB_CONTENTS_ID = 42;
/** The view a bind comes from; every observation is addressed back to it. */
const SUBSCRIBER_WC_ID = 77;
/** A second view of the same project, which binds nothing of its own. */
const OTHER_SUBSCRIBER_WC_ID = 78;
const MAIN_FRAME_ID = "frame-main";
const MAIN_CONTEXT_ID = 7;
const IFRAME_CONTEXT_ID = 9;
/** The picker's isolated world, the only context its binding is trusted from. */
const ISOLATED_CONTEXT_ID = 31;
const BINDING_NAME = "__binding";

type Command = { method: string; params?: Record<string, unknown> };

class FakeDebugger extends EventEmitter {
  readonly commands: Command[] = [];
  attached = false;
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
    if (method === "Page.createIsolatedWorld") {
      return { executionContextId: ISOLATED_CONTEXT_ID };
    }
    return {};
  }
  methods(): string[] {
    return this.commands.map((c) => c.method);
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  constructor(readonly id: number = WEB_CONTENTS_ID) {
    super();
  }
  /** What the guest currently shows; a test navigates by setting it before `did-navigate`. */
  url = "http://localhost:5173/";
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
}

function makeHarness(overrides: { guestProject?: string | null; panelKind?: string } = {}) {
  const wc = new FakeWebContents();
  // The view that binds. Separate from the guest, which is a `<webview>` and
  // never a project view of its own.
  const subscriber = new FakeWebContents(SUBSCRIBER_WC_ID);
  const otherSubscriber = new FakeWebContents(OTHER_SUBSCRIBER_WC_ID);
  const sunk: ElementPickerPushPayload[] = [];
  let sessionCounter = 0;
  const assetLoad: {
    gate: Promise<void> | null;
    /** Called when a load starts, so a test can wait for the read to be in flight. */
    onEnter: (() => void) | null;
  } = { gate: null, onEnter: null };
  const bridge = new SitePreviewBridge({
    getWebContents: (id) => {
      if (id === WEB_CONTENTS_ID) return wc as unknown as Electron.WebContents;
      if (id === SUBSCRIBER_WC_ID) return subscriber as unknown as Electron.WebContents;
      if (id === OTHER_SUBSCRIBER_WC_ID) return otherSubscriber as unknown as Electron.WebContents;
      return null;
    },
    resolveWebContentsId: (panelId) => (panelId === PANEL_ID ? WEB_CONTENTS_ID : undefined),
    getPanelKind: () => overrides.panelKind ?? "dev-preview",
    resolveGuestProject: () =>
      overrides.guestProject === undefined ? PROJECT_ID : overrides.guestProject,
    newSessionId: () => `session-${++sessionCounter}`,
    newBindingName: () => BINDING_NAME,
    // Enough of the picker's catalog to install its bootstrap; no probe or extractor ships.
    loadCoreGuestAsset: async (id) => {
      if (id !== "bootstrap") return null;
      assetLoad.onEnter?.();
      if (assetLoad.gate) await assetLoad.gate;
      return "/* bootstrap */";
    },
  });
  const bind = (
    over: Partial<{
      panelId: string;
      mode: SitePreviewMode;
      subscriberWebContentsId: number;
      sink: ElementPickerSink;
    }> = {}
  ) =>
    bridge.bindElementPicker({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      mode: "browse",
      subscriberWebContentsId: SUBSCRIBER_WC_ID,
      sink: (payload) => sunk.push(payload),
      ...over,
    });
  return { bridge, wc, subscriber, otherSubscriber, sunk, bind, assetLoad };
}

type Harness = ReturnType<typeof makeHarness>;

/** Replay the execution-context announcements CDP makes after `Runtime.enable`. */
function announceContexts(wc: FakeWebContents): void {
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
    context: { id: MAIN_CONTEXT_ID, auxData: { isDefault: true, frameId: MAIN_FRAME_ID } },
  });
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
    context: { id: IFRAME_CONTEXT_ID, auxData: { isDefault: true, frameId: "frame-ad" } },
  });
}

const HOVER_CLEARED = { type: "hoverChanged", observation: null };

function documentReady(url = "http://localhost:5173/") {
  return {
    type: "documentReady",
    url,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  };
}

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION,
    sessionId: "session-1",
    documentEpoch: 0,
    sequence: 0,
    event: HOVER_CLEARED,
    ...over,
  });
}

function callBinding(wc: FakeWebContents, payload: string, contextId = ISOLATED_CONTEXT_ID): void {
  wc.debugger.emit("message", {} as Electron.Event, "Runtime.bindingCalled", {
    name: BINDING_NAME,
    executionContextId: contextId,
    payload,
  });
}

function evaluations(harness: Harness): Command[] {
  return harness.wc.debugger.commands.filter((c) => c.method === "Runtime.evaluate");
}

/** The bootstrap installs: each carries the epoch and install id it was built for. */
function bootstraps(harness: Harness): string[] {
  return evaluations(harness)
    .map((c) => String(c.params?.expression))
    .filter((expression) => expression.includes("const DOCUMENT_EPOCH = "));
}

function epochOf(source: string | undefined): number {
  return Number(/DOCUMENT_EPOCH = (\d+)/.exec(String(source))?.[1]);
}

function retirements(harness: Harness): Command[] {
  return evaluations(harness).filter((c) => String(c.params?.expression).includes("api.retire()"));
}

function pickerEvents(sunk: ElementPickerPushPayload[]) {
  return sunk.filter((p) => p.kind === "picker-event");
}

function detachedWith(sunk: ElementPickerPushPayload[], reason: string): boolean {
  return sunk.some((p) => p.kind === "detached" && p.reason === reason);
}

function gate(debuggerFake: FakeDebugger, method: string): () => void {
  let release!: () => void;
  debuggerFake.gates.set(
    method,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  return () => {
    debuggerFake.gates.delete(method);
    release();
  };
}

describe("SitePreviewBridge", () => {
  let harness: Harness;

  beforeEach(() => {
    // Every harness reuses the guest's id, so a lease entry left behind by a
    // previous test would hand the next one the retired debugger session.
    __resetCdpLeasesForTests();
    harness = makeHarness();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  it("leases Page and Runtime, then installs the bootstrap into a world of its own", async () => {
    await harness.bind({ mode: "select" });

    const methods = harness.wc.debugger.methods();
    const world = methods.indexOf("Page.createIsolatedWorld");
    expect(methods.indexOf("Page.enable")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Page.enable")).toBeLessThan(world);
    expect(methods.indexOf("Runtime.enable")).toBeLessThan(world);

    // Exposed in the picker's world only, which is the world the bootstrap runs in.
    const added = harness.wc.debugger.commands.find((c) => c.method === "Runtime.addBinding");
    const created = harness.wc.debugger.commands.find(
      (c) => c.method === "Page.createIsolatedWorld"
    );
    expect(added?.params?.name).toBe(BINDING_NAME);
    expect(typeof added?.params?.executionContextName).toBe("string");
    expect(created?.params).toMatchObject({
      frameId: MAIN_FRAME_ID,
      worldName: added?.params?.executionContextName,
    });

    const install = evaluations(harness).find((c) =>
      String(c.params?.expression).includes("const DOCUMENT_EPOCH = ")
    );
    expect(install?.params?.contextId).toBe(ISOLATED_CONTEXT_ID);
    const source = String(install?.params?.expression);
    expect(source).toContain('"session-1"');
    expect(source).toContain(`"${BINDING_NAME}"`);
    expect(epochOf(source)).toBe(0);
    expect(source).toContain('mode: "select"');
    // The current document only: a registration that outlives it is how an
    // old epoch's guest would end up in the next one.
    expect(methods).not.toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("registers no binding when the bridge shuts down while the bootstrap is loading", async () => {
    let release!: () => void;
    harness.assetLoad.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      harness.assetLoad.onEnter = resolve;
    });

    // Handled from the start: it settles while the shutdown is awaited.
    const bind = harness.bind().then(
      () => null,
      (err: unknown) => err
    );
    // Wait for the read to be in flight: a shutdown before the bind even runs
    // proves nothing.
    await entered;
    const shutdown = harness.bridge.disposeAll();
    release();
    await shutdown;
    expect(await bind).toMatchObject({ code: "CANCELLED" });

    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    // The install saw the binding go under its read and put nothing in the page.
    expect(harness.wc.debugger.methods()).not.toContain("Runtime.addBinding");
    expect(harness.wc.debugger.methods()).not.toContain("Page.createIsolatedWorld");
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    expect(detachedWith(harness.sunk, "host-shutdown")).toBe(true);
  });

  it("registers no successor when the bridge shuts down while a rebind tears down its predecessor", async () => {
    const first = await harness.bind();
    // Hold the predecessor's teardown on a CDP call so a shutdown can land
    // while the successor is still waiting to be inserted.
    let release!: () => void;
    harness.wc.debugger.gates.set(
      "Runtime.removeBinding",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const rebind = harness.bind();
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    });
    const shutdown = harness.bridge.disposeAll();
    harness.wc.debugger.gates.delete("Runtime.removeBinding");
    release();
    await shutdown;

    await expect(rebind).rejects.toThrow(/shutting down/);
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    expect(harness.bridge.getState(PROJECT_ID, "session-2")).toBeNull();
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("forwards an envelope that matches the binding's expectations", async () => {
    await harness.bind();
    harness.sunk.length = 0;

    callBinding(harness.wc, envelope());

    expect(harness.sunk).toEqual([
      {
        kind: "picker-event",
        sessionId: "session-1",
        panelId: PANEL_ID,
        projectId: PROJECT_ID,
        documentEpoch: 0,
        sequence: 0,
        event: HOVER_CLEARED,
      },
    ]);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(0);
  });

  it("drops an event with no usable type, and a malformed lifecycle event", async () => {
    await harness.bind();
    harness.sunk.length = 0;

    callBinding(harness.wc, envelope({ event: { observation: null } }));
    callBinding(harness.wc, envelope({ sequence: 1, event: { type: "" } }));
    // Readiness is a payload fact the host acts on, so a `documentReady`
    // missing the fields that describe the document must not flip the flag.
    callBinding(harness.wc, envelope({ sequence: 2, event: { type: "documentReady" } }));

    expect(harness.sunk).toHaveLength(0);
    const state = harness.bridge.getState(PROJECT_ID, "session-1");
    expect(state?.droppedMessages).toBe(3);
    expect(state?.guestReady).toBe(false);
  });

  it("drops mismatched-session, replayed, stale, wrong-version, foreign-context and oversized traffic", async () => {
    await harness.bind();
    announceContexts(harness.wc);
    callBinding(harness.wc, envelope({ sequence: 5 }));
    harness.sunk.length = 0;

    // Another session's id, a replayed sequence, a future epoch, a wrong
    // protocol version, the page's main world, an iframe's context, an
    // unannounced context, and a body over the cap.
    callBinding(harness.wc, envelope({ sessionId: "session-2", sequence: 6 }));
    callBinding(harness.wc, envelope({ sequence: 5 }));
    callBinding(harness.wc, envelope({ sequence: 6, documentEpoch: 1 }));
    callBinding(
      harness.wc,
      envelope({ sequence: 6, protocolVersion: ELEMENT_PICKER_PROTOCOL_VERSION + 1 })
    );
    callBinding(harness.wc, envelope({ sequence: 6 }), MAIN_CONTEXT_ID);
    callBinding(harness.wc, envelope({ sequence: 6 }), IFRAME_CONTEXT_ID);
    callBinding(harness.wc, envelope({ sequence: 6 }), 12345);
    // Valid apart from its length: trailing whitespace parses, so only the size ceiling refuses it.
    callBinding(harness.wc, envelope({ sequence: 6 }) + " ".repeat(300_000));

    expect(harness.sunk).toHaveLength(0);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(8);
    // The accepted watermark did not move, so a legitimate next message lands.
    callBinding(harness.wc, envelope({ sequence: 6 }));
    expect(pickerEvents(harness.sunk)).toHaveLength(1);
  });

  it("treats the guest's post-navigation sequence reset as new, not replayed", async () => {
    await harness.bind();
    callBinding(harness.wc, envelope({ sequence: 4, event: documentReady() }));
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.guestReady).toBe(true);

    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.sunk.some((p) => p.kind === "epoch-advanced")).toBe(true);
    });
    const state = harness.bridge.getState(PROJECT_ID, "session-1");
    expect(state?.documentEpoch).toBe(1);
    expect(state?.guestReady).toBe(false);
    harness.sunk.length = 0;

    // Sequence 0 again — below the previous epoch's watermark, yet current.
    callBinding(harness.wc, envelope({ documentEpoch: 1, sequence: 0 }));
    expect(pickerEvents(harness.sunk)).toHaveLength(1);

    // Anything still claiming the previous epoch describes a document that no
    // longer exists.
    harness.sunk.length = 0;
    callBinding(harness.wc, envelope({ documentEpoch: 0, sequence: 99 }));
    expect(harness.sunk).toHaveLength(0);
  });

  it("reinstalls the bootstrap with the new epoch on navigation", async () => {
    await harness.bind();
    expect(bootstraps(harness).map(epochOf)).toEqual([0]);

    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.sunk).toContainEqual({
        kind: "epoch-advanced",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        documentEpoch: 1,
      });
    });

    expect(bootstraps(harness).map(epochOf)).toEqual([0, 1]);
    // A fresh world per document: the previous one went with its document.
    expect(
      harness.wc.debugger.methods().filter((m) => m === "Page.createIsolatedWorld")
    ).toHaveLength(2);
  });

  it("withholds the bootstrap from a page outside the origin policy, and keeps the binding", async () => {
    harness.wc.url = "https://example.com/pricing";
    const state = await harness.bind();
    expect(state.suspended).toBe(true);
    const methods = harness.wc.debugger.methods();
    expect(methods).not.toContain("Runtime.addBinding");
    expect(methods).not.toContain("Page.createIsolatedWorld");
    expect(methods).not.toContain("Runtime.evaluate");
    expect(harness.sunk).toContainEqual({
      kind: "origin-policy",
      sessionId: "session-1",
      projectId: PROJECT_ID,
      documentEpoch: 0,
      suspended: true,
    });
    expect(harness.sunk.some((p) => p.kind === "detached")).toBe(false);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
  });

  it("suspends when the preview leaves the local origin and resumes on the way back", async () => {
    await harness.bind();
    const worldsBefore = harness.wc.debugger
      .methods()
      .filter((m) => m === "Page.createIsolatedWorld").length;

    harness.wc.url = "https://accounts.example.com/login";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.sunk).toContainEqual({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        documentEpoch: 1,
        suspended: true,
      });
    });
    // The binding goes, which closes the tap, and anything of ours still in
    // the page is told to retire, as on teardown.
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    const [retire] = retirements(harness);
    expect(retirements(harness)).toHaveLength(1);
    expect(retire?.params?.contextId).toBe(ISOLATED_CONTEXT_ID);
    expect(bootstraps(harness)).toHaveLength(1);
    expect(
      harness.wc.debugger.methods().filter((m) => m === "Page.createIsolatedWorld")
    ).toHaveLength(worldsBefore);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);

    // Traffic from the excluded document is ignored, not counted as abuse.
    callBinding(harness.wc, envelope({ documentEpoch: 1, event: documentReady() }));
    expect(pickerEvents(harness.sunk)).toHaveLength(0);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(0);

    harness.wc.url = "http://127.0.0.1:5173/";
    // The bootstrap reports `documentReady` from inside the install's
    // evaluate, before that call returns. Held here so the readiness lands
    // while the resumed install is still in flight: it must not be ignored as
    // suspended traffic.
    const releaseEvaluate = gate(harness.wc.debugger, "Runtime.evaluate");
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.sunk).toContainEqual({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        documentEpoch: 2,
        suspended: false,
      });
    });
    await vi.waitFor(() => {
      expect(bootstraps(harness).map(epochOf)).toEqual([0, 2]);
    });
    callBinding(
      harness.wc,
      envelope({ documentEpoch: 2, event: documentReady("http://127.0.0.1:5173/") })
    );
    releaseEvaluate();
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.guestReady).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(false);
    // The admitted `documentReady` scheduled the picker's late probe.
    await harness.bridge.disposeAll();
  });

  it("withholds the bootstrap from a document that arrived while the install was in flight", async () => {
    // The bind's install is past its policy check and waiting on CDP when the
    // page leaves for a foreign origin. That install must not evaluate into the
    // foreign document, and the reinstall the navigation queued must remove the
    // binding it added.
    const releaseAddBinding = gate(harness.wc.debugger, "Runtime.addBinding");
    const bound = harness.bind();
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Runtime.addBinding");
    });
    harness.wc.url = "https://example.com/";
    harness.wc.emit("did-navigate");
    releaseAddBinding();
    await bound;
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });

    expect(bootstraps(harness)).toHaveLength(0);
    const methods = harness.wc.debugger.methods();
    expect(methods.lastIndexOf("Runtime.removeBinding")).toBeGreaterThan(
      methods.lastIndexOf("Runtime.addBinding")
    );
  });

  it("refuses a panel embedded by another project's view", async () => {
    const foreign = makeHarness({ guestProject: "project-2" });
    await expect(foreign.bind()).rejects.toMatchObject({ code: "PERMISSION" });
    expect(foreign.wc.debugger.methods()).toEqual([]);
  });

  it("refuses a panel that is not a dev preview", async () => {
    const browserPanel = makeHarness({ panelKind: "browser" });
    await expect(browserPanel.bind()).rejects.toThrow(/not a dev preview/i);
    expect(browserPanel.wc.debugger.methods()).toEqual([]);
  });

  it("refuses a panel with no dev preview behind it", async () => {
    await expect(harness.bind({ panelId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(harness.wc.debugger.methods()).toEqual([]);
  });

  it("scopes state reads and detach to the binding's project", async () => {
    await harness.bind();

    expect(harness.bridge.getState("project-2", "session-1")).toBeNull();
    await harness.bridge.detach("project-2", "session-1");
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).not.toBeNull();
    expect(harness.sunk.some((p) => p.kind === "detached")).toBe(false);
  });

  it("removes the installed bootstrap and stops forwarding once detached", async () => {
    await harness.bind();
    const installId = /INSTALL_ID = (\d+)/.exec(bootstraps(harness)[0] ?? "")?.[1];
    harness.sunk.length = 0;

    await harness.bridge.detach(PROJECT_ID, "session-1");

    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    // Matched on install id, so it can never take down a bootstrap a later
    // install put in the same world; bounded, because the page may be hostile.
    const [retire] = retirements(harness);
    expect(retire?.params?.contextId).toBe(ISOLATED_CONTEXT_ID);
    expect(String(retire?.params?.expression)).toContain(`api.installId !== ${installId}`);
    expect(retire?.params?.timeout).toBeGreaterThan(0);
    expect(harness.sunk).toEqual([
      { kind: "detached", sessionId: "session-1", projectId: PROJECT_ID, reason: "requested" },
    ]);

    harness.sunk.length = 0;
    callBinding(harness.wc, envelope({ sequence: 1 }));
    expect(harness.sunk).toHaveLength(0);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });

  it("supersedes an existing binding when the same panel is bound again", async () => {
    await harness.bind();
    const second = await harness.bind();

    expect(second.sessionId).toBe("session-2");
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    expect(harness.bridge.getState(PROJECT_ID, "session-2")).not.toBeNull();
    expect(detachedWith(harness.sunk, "rebound")).toBe(true);
  });

  it("reads the contexts from the shared snapshot without cycling the Runtime domain", async () => {
    // The webview console capture enables Runtime for dev-preview panels too,
    // and only the first enable replays the contexts. The bridge reads the
    // snapshot the lease service keeps, so the domain is enabled once and
    // never cycled.
    const consoleLease = await acquireCdpLease(harness.wc as unknown as Electron.WebContents, [
      "Runtime",
    ]);
    announceContexts(harness.wc);

    await harness.bind();

    const methods = harness.wc.debugger.methods();
    expect(methods.filter((m) => m === "Runtime.enable").length).toBe(1);
    expect(methods).not.toContain("Runtime.disable");

    // A context the snapshot knows is still not the picker's world.
    callBinding(harness.wc, envelope());
    expect(pickerEvents(harness.sunk)).toHaveLength(1);
    harness.sunk.length = 0;
    callBinding(harness.wc, envelope({ sequence: 1 }), MAIN_CONTEXT_ID);
    expect(pickerEvents(harness.sunk)).toHaveLength(0);

    await consoleLease.release();
  });

  it("installs one live binding when two binds for the same panel race", async () => {
    const [first, second] = await Promise.all([harness.bind(), harness.bind()]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(harness.bridge.getState(PROJECT_ID, second.sessionId)).not.toBeNull();
    expect(harness.bridge.getState(PROJECT_ID, first.sessionId)).toBeNull();
    // One live listener set, not two: the superseded binding removed its own.
    // The second message listener is the CDP lease service's context tracker,
    // one per guest however many consumers it serves.
    expect(harness.wc.debugger.listenerCount("message")).toBe(2);
    expect(harness.wc.listenerCount("did-navigate")).toBe(1);
  });

  it("gives each install a higher id than the bootstrap it replaces", async () => {
    await harness.bind();
    await harness.bind();

    const installIds = bootstraps(harness).map((source) =>
      Number(/INSTALL_ID = (\d+)/.exec(source)?.[1])
    );
    expect(installIds).toHaveLength(2);
    // A rebind restarts the epoch at 0, so the epoch cannot order these — the
    // install id is what lets the incoming bootstrap displace the outgoing one.
    expect(installIds[1]!).toBeGreaterThan(installIds[0]!);
  });

  it("stops parsing once a flooding guest exhausts its per-second budget", async () => {
    await harness.bind();
    harness.sunk.length = 0;

    for (let i = 0; i < 400; i++) callBinding(harness.wc, envelope({ sequence: i }));

    const forwarded = pickerEvents(harness.sunk).length;
    expect(forwarded).toBeGreaterThan(0);
    // The excess is counted and discarded rather than parsed, so a tight loop in
    // the page cannot set the main process's CPU budget.
    expect(forwarded).toBeLessThan(400);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(400 - forwarded);
  });

  it("fails the bind and removes what it installed when the bootstrap throws in the guest", async () => {
    harness.wc.debugger.responses.set("Runtime.evaluate", {
      exceptionDetails: { text: "Uncaught TypeError" },
    });

    await expect(harness.bind()).rejects.toThrow(/threw while initialising/);

    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    expect(retirements(harness)).toHaveLength(1);
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    expect(detachedWith(harness.sunk, "install-failed")).toBe(true);
  });

  it("still retires the bootstrap and releases the lease when removing the binding fails", async () => {
    await harness.bind();
    harness.wc.debugger.rejects.set("Runtime.removeBinding", new Error("something unexpected"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await harness.bridge.detach(PROJECT_ID, "session-1");

    // Each removal stands alone: one failing must not leave the bootstrap
    // running or the domains held.
    expect(retirements(harness)).toHaveLength(1);
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(false);
    expect(detachedWith(harness.sunk, "requested")).toBe(true);
    warn.mockRestore();
  });

  it("tears the binding down when the debugger is detached from a live guest", async () => {
    await harness.bind();

    harness.wc.debugger.emit("detach", {} as Electron.Event, "target closed");

    await vi.waitFor(() => {
      expect(detachedWith(harness.sunk, "debugger-detached")).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });

  it("removes the transport from a guest that keeps sending invalid traffic", async () => {
    await harness.bind();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Wrong session every time: never admitted as an observation, always dropped.
    for (let i = 0; i < 6_000; i++) {
      callBinding(harness.wc, envelope({ sessionId: "forged", sequence: i }));
    }

    await vi.waitFor(() => {
      expect(detachedWith(harness.sunk, "guest-flooding")).toBe(true);
    });
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    // Log output stays bounded regardless of how much the page sends.
    expect(warn.mock.calls.length).toBeLessThan(5);
    warn.mockRestore();
  });

  it("never trips the flood breaker on drops spread across a long session", async () => {
    vi.useFakeTimers();
    try {
      await harness.bind();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Far more lifetime drops than the threshold, but never many in one window.
      for (let minute = 0; minute < 30; minute++) {
        for (let i = 0; i < 1_000; i++) {
          callBinding(harness.wc, envelope({ sessionId: "stale", sequence: i }));
        }
        vi.advanceTimersByTime(60_000);
      }

      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.droppedMessages).toBe(30_000);
      expect(harness.sunk.some((p) => p.kind === "detached")).toBe(false);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a detach racing a rebind displace the new binding", async () => {
    await harness.bind();

    const [, rebound] = await Promise.all([
      harness.bridge.detach(PROJECT_ID, "session-1"),
      harness.bind(),
    ]);

    expect(harness.bridge.getState(PROJECT_ID, rebound.sessionId)).not.toBeNull();
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
    // The bridge's own listener plus the lease service's context tracker.
    expect(harness.wc.debugger.listenerCount("message")).toBe(2);
  });

  it("refuses new binds once the bridge is shutting down", async () => {
    await harness.bind();

    const shutdown = harness.bridge.disposeAll();
    const late = harness.bind();

    await shutdown;
    await expect(late).rejects.toThrow(/shutting down/);
    expect(harness.wc.debugger.listenerCount("message")).toBe(0);
  });

  it("releases a lease acquired after teardown stopped waiting for it", async () => {
    vi.useFakeTimers();
    try {
      const releaseEnable = gate(harness.wc.debugger, "Page.enable");
      const bound = harness.bind();
      await vi.waitFor(() => {
        expect(harness.wc.debugger.methods()).toContain("Page.enable");
      });

      // Teardown gives the queued install a bounded wait and moves on.
      const shutdown = harness.bridge.disposeAll();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;

      releaseEnable();
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
      const releaseFrameTree = gate(harness.wc.debugger, "Page.getFrameTree");
      const bound = harness.bind();
      await vi.waitFor(() => {
        expect(harness.wc.debugger.methods()).toContain("Page.getFrameTree");
      });
      const shutdown = harness.bridge.disposeAll();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;

      releaseFrameTree();
      await bound.catch(() => undefined);
      await vi.runAllTimersAsync();

      // Nothing the resumed install did may outlive the teardown that gave up
      // on it: no binding registered, no world made, nothing evaluated.
      const methods = harness.wc.debugger.methods();
      expect(methods).not.toContain("Runtime.addBinding");
      expect(methods).not.toContain("Page.createIsolatedWorld");
      expect(bootstraps(harness)).toHaveLength(0);
      expect(harness.wc.debugger.listenerCount("message")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not install twice for one epoch when a navigation lands mid-install", async () => {
    // Two installs for the same epoch both start the bootstrap's sequence at
    // 0, so the host drops the second one's messages as replays and the
    // inspector goes silent after an ordinary quick navigation.
    const releaseFrameTree = gate(harness.wc.debugger, "Page.getFrameTree");

    const bound = harness.bind();
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Page.getFrameTree");
    });
    harness.wc.emit("did-navigate");
    releaseFrameTree();
    await bound;

    // Uniqueness holds in the window before the queued reinstall runs, so
    // polling on it would pass early. Wait until the navigation's reinstall has
    // actually been processed, then assert once.
    await vi.waitFor(() => {
      expect(harness.sunk.some((p) => p.kind === "epoch-advanced")).toBe(true);
    });
    const epochs = bootstraps(harness).map(epochOf);
    expect(epochs.length).toBeGreaterThan(0);
    expect(new Set(epochs).size).toBe(epochs.length);
  });

  it("re-applies a mode switch made while the bootstrap was still installing", async () => {
    const releaseWorld = gate(harness.wc.debugger, "Page.createIsolatedWorld");

    const bound = harness.bind({ mode: "select" });
    await vi.waitFor(() => {
      expect(harness.wc.debugger.methods()).toContain("Page.createIsolatedWorld");
    });
    await harness.bridge.setMode(PROJECT_ID, "session-1", "browse");
    releaseWorld();
    await bound;

    // The installed source baked in "select"; without the re-apply the host
    // would report Browse while the page kept intercepting clicks.
    expect(bootstraps(harness)[0]).toContain('mode: "select"');
    const last = evaluations(harness).at(-1);
    expect(String(last?.params?.expression)).toContain('api.setMode("browse")');
    expect(last?.params?.contextId).toBe(ISOLATED_CONTEXT_ID);
    expect(harness.bridge.getState(PROJECT_ID, "session-1")?.mode).toBe("browse");
  });

  it("detaches when the guest webContents goes away", async () => {
    await harness.bind();

    harness.wc.emit("destroyed");
    await vi.waitFor(() => {
      expect(detachedWith(harness.sunk, "guest-destroyed")).toBe(true);
    });
    expect(harness.bridge.getState(PROJECT_ID, "session-1")).toBeNull();
  });
});

describe("SitePreviewBridge out-of-band ops", () => {
  beforeEach(() => {
    __resetCdpLeasesForTests();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  /** Bind, then navigate somewhere the origin policy excludes. */
  async function suspendedHarness() {
    const harness = makeHarness();
    await harness.bind();
    harness.wc.url = "https://accounts.example.com/login";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    return harness;
  }

  it("evaluates nothing in a document the origin policy excluded", async () => {
    const harness = await suspendedHarness();
    harness.wc.debugger.responses.set("Runtime.evaluate", { result: { value: true } });
    const before = evaluations(harness).length;

    const state = await harness.bridge.setMode(PROJECT_ID, "session-1", "select");
    const found = await harness.bridge.reselectElementPicker(PROJECT_ID, "session-1", {
      sessionId: "session-1",
      framework: "svelte",
      locator: {
        loc: { file: "src/routes/+page.svelte", line: 12, column: 4 },
        index: 0,
        component: { file: "src/lib/Card.svelte", line: 1, column: 0 },
      },
    });
    await harness.bridge.clearSelection(PROJECT_ID, "session-1");
    await harness.bridge.clearHover(PROJECT_ID, "session-1");

    // The mode is still recorded — the next install bakes it in — but nothing
    // was driven in the third-party document, and no source path reached it.
    expect(state.mode).toBe("select");
    expect(found).toBe(false);
    expect(evaluations(harness)).toHaveLength(before);
    const sources = evaluations(harness).map((c) => String(c.params?.expression));
    expect(sources.some((e) => e.includes("+page.svelte"))).toBe(false);
    expect(sources.some((e) => e.includes("Card.svelte"))).toBe(false);
  });

  it("carries the mode set while suspended into the resumed install", async () => {
    const harness = await suspendedHarness();
    await harness.bridge.setMode(PROJECT_ID, "session-1", "select");

    harness.wc.url = "http://localhost:5173/";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(false);
    });
    await vi.waitFor(() => {
      expect(bootstraps(harness)).toHaveLength(2);
    });
    expect(bootstraps(harness).at(-1)).toContain('mode: "select"');
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
    const state = await harness.bind();
    expect(state.suspended).toBe(false);
    expect(harness.wc.debugger.methods()).toContain("Page.createIsolatedWorld");
    expect(bootstraps(harness)).toHaveLength(1);
  });

  it("suspends when a page navigates to about:blank", async () => {
    // A top-level navigation to about:blank inherits the initiator's origin,
    // so the blank allowance ends the moment anything has been committed.
    const harness = makeHarness();
    await harness.bind();

    harness.wc.url = "about:blank";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    expect(harness.sunk).toContainEqual({
      kind: "origin-policy",
      sessionId: "session-1",
      projectId: PROJECT_ID,
      documentEpoch: 1,
      suspended: true,
    });
    expect(bootstraps(harness)).toHaveLength(1);
  });
});

/**
 * Who a binding's observations are for. They carry the structure of the user's
 * page, what they selected in it and source locations from their repository, so
 * the answer is the one view that bound — not every view of the project.
 */
describe("SitePreviewBridge observation addressing", () => {
  beforeEach(() => {
    __resetCdpLeasesForTests();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  it("sends every kind the bridge emits to the binding's own sink", async () => {
    const harness = makeHarness();
    await harness.bind();

    // One of each kind the bridge emits: a picker event, an epoch advance, an
    // origin-policy change and the detach.
    callBinding(harness.wc, envelope());
    harness.wc.url = "https://example.com/";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, "session-1")?.suspended).toBe(true);
    });
    await harness.bridge.detach(PROJECT_ID, "session-1");

    const kinds = new Set(harness.sunk.map((p) => p.kind));
    expect(kinds).toContain("picker-event");
    expect(kinds).toContain("epoch-advanced");
    expect(kinds).toContain("origin-policy");
    expect(kinds).toContain("detached");
    expect(harness.sunk.every((p) => p.sessionId === "session-1")).toBe(true);
  });

  it("re-addresses to the new view when another one rebinds the same panel", async () => {
    const harness = makeHarness();
    const first: ElementPickerPushPayload[] = [];
    const second: ElementPickerPushPayload[] = [];
    await harness.bind({ sink: (p) => first.push(p) });
    await harness.bind({
      subscriberWebContentsId: OTHER_SUBSCRIBER_WC_ID,
      sink: (p) => second.push(p),
    });
    // The first view hears that it was superseded, and nothing of the successor.
    expect(first.at(-1)).toMatchObject({ kind: "detached", reason: "rebound" });
    first.length = 0;
    second.length = 0;

    callBinding(harness.wc, envelope({ sessionId: "session-2" }));

    expect(first).toHaveLength(0);
    expect(pickerEvents(second)).toHaveLength(1);
    expect(second[0]?.sessionId).toBe("session-2");
  });

  // A view can bind several previews; a `destroyed` listener each would run
  // its count past the unpackaged build's limit.
  it("watches the binding view through its shared destroyed listener", async () => {
    const harness = makeHarness();
    const unwatch = onWebContentsDestroyed(
      harness.subscriber as unknown as Electron.WebContents,
      () => {}
    );
    expect(harness.subscriber.listenerCount("destroyed")).toBe(1);
    await harness.bind();
    expect(harness.subscriber.listenerCount("destroyed")).toBe(1);
    unwatch();
  });

  it("tears the binding down when the view that bound is destroyed", async () => {
    const harness = makeHarness();
    const state = await harness.bind();

    harness.subscriber.emit("destroyed");

    await vi.waitFor(() => {
      expect(harness.sunk.at(-1)).toEqual({
        kind: "detached",
        sessionId: state.sessionId,
        projectId: PROJECT_ID,
        reason: "subscriber-destroyed",
      });
    });
    expect(harness.bridge.getState(PROJECT_ID, state.sessionId)).toBeNull();
    // The bootstrap in the user's page goes with it: nothing is left listening,
    // so leaving it observing would be a tap with no consumer.
    expect(harness.wc.debugger.methods()).toContain("Runtime.removeBinding");
    expect(retirements(harness)).toHaveLength(1);
  });
});

describe("SitePreviewBridge core picker reselect", () => {
  const request = {
    sessionId: "session-1",
    elementId: "el-3",
    framework: "svelte" as const,
    locator: {
      loc: { file: "src/routes/+page.svelte", line: 12, column: 4 },
      index: 1,
      component: { file: "src/lib/Card.svelte", line: 1, column: 0 },
    },
    reveal: false,
  };

  beforeEach(() => {
    __resetCdpLeasesForTests();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  async function coreHarness() {
    const harness = makeHarness();
    const state = await harness.bind({ mode: "select" });
    return { ...harness, state };
  }

  function reselects(harness: Harness) {
    return evaluations(harness).filter((c) =>
      String(c.params?.expression).includes("api.reselect(")
    );
  }

  it("asks the binding's own guest, with the request rebuilt from fields it checked", async () => {
    const harness = await coreHarness();
    harness.wc.debugger.responses.set("Runtime.evaluate", { result: { value: true } });

    const smuggled = { ...request, toJSON: "x", script: "alert(1)" } as typeof request;
    await expect(
      harness.bridge.reselectElementPicker(PROJECT_ID, harness.state.sessionId, smuggled)
    ).resolves.toBe(true);

    const [call] = reselects(harness);
    expect(call?.params).toMatchObject({ contextId: ISOLATED_CONTEXT_ID, returnByValue: true });
    const expression = String(call?.params?.expression);
    const { sessionId, ...forwarded } = request;
    expect(expression).toContain(JSON.stringify(forwarded));
    expect(expression).not.toContain("alert(1)");
    expect(expression).not.toContain(sessionId);
  });

  it("answers false for a locator it cannot bound", async () => {
    const core = await coreHarness();
    core.wc.debugger.responses.set("Runtime.evaluate", { result: { value: true } });
    for (const locator of [
      { ...request.locator, index: -1 },
      { ...request.locator, loc: { ...request.locator.loc, line: Number.NaN } },
      { ...request.locator, component: { file: "", line: 1, column: 0 } },
    ]) {
      await expect(
        core.bridge.reselectElementPicker(PROJECT_ID, core.state.sessionId, {
          ...request,
          locator,
        })
      ).resolves.toBe(false);
    }
    expect(reselects(core)).toHaveLength(0);
  });

  it("carries no source path into a document the origin policy excluded", async () => {
    const harness = await coreHarness();
    harness.wc.url = "https://accounts.example.com/login";
    harness.wc.emit("did-navigate");
    await vi.waitFor(() => {
      expect(harness.bridge.getState(PROJECT_ID, harness.state.sessionId)?.suspended).toBe(true);
    });
    harness.wc.debugger.responses.set("Runtime.evaluate", { result: { value: true } });

    await expect(
      harness.bridge.reselectElementPicker(PROJECT_ID, harness.state.sessionId, request)
    ).resolves.toBe(false);
    expect(reselects(harness)).toHaveLength(0);
  });

  it("refuses a session that is not the caller project's", async () => {
    const harness = await coreHarness();
    await expect(
      harness.bridge.reselectElementPicker("project-2", harness.state.sessionId, request)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      harness.bridge.reselectElementPicker(PROJECT_ID, "session-unknown", request)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(reselects(harness)).toHaveLength(0);
  });
});
