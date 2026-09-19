/**
 * #12514: `terminal:data` is relayed to the owning project's views only —
 * cached ones included, since a cached view has no resync path on warm
 * reactivation — instead of to every renderer in the app. Drives the real
 * `broadcastToProjectRenderers` over the real view registry so the routing
 * under test is production code, not a fixture's idea of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { liveWebContents } = vi.hoisted(() => ({
  liveWebContents: new Map<number, unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  WebContentsView: class {},
  webContents: { fromId: (id: number) => liveWebContents.get(id) ?? null },
}));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";
import {
  registerAppView,
  registerCachedViewWebContents,
  registerProjectView,
  unregisterAppView,
  unregisterProjectView,
} from "../../../../window/webContentsRegistry.js";
import type { HandlerDependencies } from "../../../types.js";

interface FakeWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

function makeWebContents(id: number): FakeWebContents {
  const wc: FakeWebContents = {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  liveWebContents.set(id, wc);
  return wc;
}

function makeWindow(id: number) {
  return { id, isDestroyed: () => false };
}

function dataSends(wc: FakeWebContents) {
  return wc.send.mock.calls.filter((call) => call[0] === CHANNELS.TERMINAL_DATA);
}

describe("terminal event handlers — terminal:data routing (#12514)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;
  const windows: Array<ReturnType<typeof makeWindow>> = [];
  const projectViewIds: number[] = [];

  function showInWindow(win: ReturnType<typeof makeWindow>, wc: FakeWebContents): void {
    registerAppView(win as never, { webContents: wc } as never);
  }

  function bindToProject(projectId: string, wc: FakeWebContents): void {
    registerProjectView(projectId, wc as never);
    projectViewIds.push(wc.id);
  }

  beforeEach(() => {
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn((id: string) => (id === "term-a" ? "project-a" : null)),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    for (const id of projectViewIds.splice(0)) unregisterProjectView(id);
    for (const win of windows.splice(0)) unregisterAppView(win as never);
    liveWebContents.clear();
  });

  describe("with project views registered", () => {
    let activeA: FakeWebContents;
    let cachedB: FakeWebContents;
    let activeB: FakeWebContents;
    let cachedA: FakeWebContents;

    beforeEach(() => {
      // Window 1 shows project A with B cached behind it; window 2 is the
      // mirror image, so project A has one visible and one cached view.
      const win1 = makeWindow(1);
      const win2 = makeWindow(2);
      windows.push(win1, win2);

      activeA = makeWebContents(11);
      cachedB = makeWebContents(12);
      activeB = makeWebContents(21);
      cachedA = makeWebContents(22);

      showInWindow(win1, activeA);
      bindToProject("project-a", activeA);
      bindToProject("project-b", cachedB);
      registerCachedViewWebContents(cachedB as never);

      showInWindow(win2, activeB);
      bindToProject("project-b", activeB);
      bindToProject("project-a", cachedA);
      registerCachedViewWebContents(cachedA as never);
    });

    it("delivers a chunk to every view of the owning project, cached ones included", () => {
      const chunk = new Uint8Array([104, 105]);

      ptyClient.emit("data", "term-a", chunk);

      expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("term-a");
      expect(dataSends(activeA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", chunk]]);
      expect(dataSends(cachedA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", chunk]]);
    });

    it("never reaches another project's views, visible or cached", () => {
      ptyClient.emit("data", "term-a", "hello");

      expect(dataSends(activeB)).toHaveLength(0);
      expect(dataSends(cachedB)).toHaveLength(0);
    });

    it("falls back to every app view when the terminal's project is unknown", () => {
      // A terminal main no longer tracks answers null — the fallback is what
      // keeps its late output from being swallowed.
      ptyClient.emit("data", "term-untracked", "late output");

      for (const wc of [activeA, cachedB, activeB, cachedA]) {
        expect(dataSends(wc)).toEqual([[CHANNELS.TERMINAL_DATA, "term-untracked", "late output"]]);
      }
    });

    it("drops a chunk whose project no view hosts", () => {
      ptyClient.getTerminalProjectId.mockReturnValue("project-evicted");

      ptyClient.emit("data", "term-evicted", "output");

      for (const wc of [activeA, cachedB, activeB, cachedA]) {
        expect(dataSends(wc)).toHaveLength(0);
      }
    });
  });

  describe("with no project views registered", () => {
    it("falls back to every app view even for a known project", () => {
      // Startup, or windows that never route through ProjectViewManager.
      const win1 = makeWindow(1);
      const win2 = makeWindow(2);
      windows.push(win1, win2);
      const first = makeWebContents(31);
      const second = makeWebContents(41);
      showInWindow(win1, first);
      showInWindow(win2, second);

      ptyClient.emit("data", "term-a", "boot output");

      expect(dataSends(first)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "boot output"]]);
      expect(dataSends(second)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "boot output"]]);
    });
  });

  it("stops relaying once the handlers are disposed", () => {
    const win = makeWindow(1);
    windows.push(win);
    const wc = makeWebContents(51);
    showInWindow(win, wc);

    dispose();
    ptyClient.emit("data", "term-a", "after dispose");

    expect(dataSends(wc)).toHaveLength(0);
    expect(ptyClient.listenerCount("data")).toBe(0);
  });
});
