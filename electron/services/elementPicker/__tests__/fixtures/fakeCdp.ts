import { EventEmitter } from "node:events";
import { vi } from "vitest";

import { SitePreviewBridge } from "../../../SitePreviewBridge.js";
import type { ElementPickerPushPayload } from "../../types.js";

/**
 * A fake debugger that evaluates every expression in this jsdom realm, so the
 * bootstrap, probe and extractors run as they would in the guest — except that
 * jsdom has one world where Chromium gives the bootstrap its own. Shared by
 * the host suites that drive the real bridge.
 */

export const PANEL_ID = "panel-1";
export const PROJECT_ID = "project-1";
export const WEB_CONTENTS_ID = 42;
export const SUBSCRIBER_WC_ID = 77;
export const ISOLATED_CONTEXT_ID = 31;
export const MAIN_FRAME_ID = "frame-main";
export const BINDING_NAME = "__pickerBinding";

export const scope = globalThis as unknown as Record<string, unknown>;

export type Command = { method: string; params: Record<string, unknown> };

export class FakeDebugger extends EventEmitter {
  attached = false;
  readonly commands: Command[] = [];
  /** The main frame's default world; a new one per document, as CDP announces them. */
  mainWorld = 1;

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }

  private announceMainWorld(): void {
    this.emit("message", {} as Electron.Event, "Runtime.executionContextCreated", {
      context: {
        id: this.mainWorld,
        uniqueId: `main-${this.mainWorld}`,
        auxData: { isDefault: true, frameId: MAIN_FRAME_ID },
      },
    });
  }

  /** Set by a navigation: the new main world is announced before the next command's reply. */
  private announcePending = false;

  /**
   * A cross-document navigation in the order Electron 42 delivers it: CDP
   * clears the contexts, Electron reports `did-navigate` — unless
   * `observed` is false, standing in for that event arriving late — and the
   * new document's main world is announced ahead of the next command's reply.
   */
  navigate(wc: EventEmitter, observed = true): void {
    this.emit("message", {} as Electron.Event, "Runtime.executionContextsCleared", {});
    this.mainWorld += 1;
    this.announcePending = true;
    if (observed) wc.emit("did-navigate");
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params });
    if (this.announcePending) {
      this.announcePending = false;
      this.announceMainWorld();
    }
    switch (method) {
      case "Runtime.enable":
        // The replay of contexts that already exist.
        this.announceMainWorld();
        return {};
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: MAIN_FRAME_ID } } };
      case "Runtime.addBinding": {
        const name = params.name as string;
        // CDP delivers binding calls asynchronously, never inside the evaluate.
        scope[name] = (payload: string) =>
          queueMicrotask(() =>
            this.emit("message", {} as Electron.Event, "Runtime.bindingCalled", {
              name,
              executionContextId: ISOLATED_CONTEXT_ID,
              payload,
            })
          );
        return {};
      }
      case "Runtime.removeBinding":
        delete scope[params.name as string];
        return {};
      case "Page.createIsolatedWorld":
        return { executionContextId: ISOLATED_CONTEXT_ID };
      case "Page.addScriptToEvaluateOnNewDocument":
        return { identifier: "script-1" };
      case "Runtime.evaluate": {
        if (
          params.uniqueContextId !== undefined &&
          params.uniqueContextId !== `main-${this.mainWorld}`
        ) {
          throw new Error("uniqueContextId not found");
        }
        try {
          const source = (params.expression as string).trim().replace(/;$/, "");
          const value = new Function(`return ${source}`)() as unknown;
          return params.returnByValue
            ? { result: { value: JSON.parse(JSON.stringify(value ?? null)) as unknown } }
            : { result: {} };
        } catch (err) {
          return { exceptionDetails: { text: String(err) } };
        }
      }
      default:
        return {};
    }
  }

  /** The evaluates the host sent, by what they install. */
  evaluates(): Array<{ kind: "isolated" | "probe" | "extractor" | "other"; framework?: string }> {
    return this.commands
      .filter((command) => command.method === "Runtime.evaluate")
      .map(({ params }) => {
        const expression = params.expression as string;
        if (params.contextId === ISOLATED_CONTEXT_ID) return { kind: "isolated" as const };
        if (expression.includes("const api = { result: null,")) return { kind: "probe" as const };
        const framework = /framework: "([a-z0-9.-]+)", installed: false/.exec(expression)?.[1];
        if (framework !== undefined) return { kind: "extractor" as const, framework };
        return { kind: "other" as const };
      });
  }
}

export class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  url = "http://localhost:5173/";
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
}

export function makeHarness(catalog: Record<string, string>) {
  const wc = new FakeWebContents(WEB_CONTENTS_ID);
  const subscriber = new FakeWebContents(SUBSCRIBER_WC_ID);
  const sunk: ElementPickerPushPayload[] = [];
  let sessions = 0;
  const bridge = new SitePreviewBridge({
    getWebContents: (id) => {
      if (id === WEB_CONTENTS_ID) return wc as unknown as Electron.WebContents;
      if (id === SUBSCRIBER_WC_ID) return subscriber as unknown as Electron.WebContents;
      return null;
    },
    resolveWebContentsId: (panelId) => (panelId === PANEL_ID ? WEB_CONTENTS_ID : undefined),
    getPanelKind: () => "dev-preview",
    resolveGuestProject: () => PROJECT_ID,
    newSessionId: () => `session-${++sessions}`,
    newBindingName: () => BINDING_NAME,
    loadCoreGuestAsset: async (id) => catalog[id] ?? null,
  });
  const bind = () =>
    bridge.bindElementPicker({
      projectId: PROJECT_ID,
      panelId: PANEL_ID,
      mode: "select",
      subscriberWebContentsId: SUBSCRIBER_WC_ID,
      sink: (payload) => sunk.push(payload),
    });
  const kinds = <K extends ElementPickerPushPayload["kind"]>(kind: K) =>
    sunk.filter((payload): payload is Extract<ElementPickerPushPayload, { kind: K }> => {
      return payload.kind === kind;
    });
  const pickerEvents = (type: string) =>
    sunk.flatMap((payload) =>
      payload.kind === "picker-event" && payload.event.type === type ? [payload] : []
    );
  const navigate = (observed = true) => wc.debugger.navigate(wc, observed);
  return { bridge, wc, sunk, bind, navigate, kinds, pickerEvents };
}

/** Lets the binding queue, binding calls and probes settle. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1) await vi.advanceTimersByTimeAsync(0);
}
