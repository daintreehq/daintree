// @vitest-environment jsdom
//
// Benchmark for the per-terminal renderer bursts on project switch / attach.
// Prints metrics with SWITCH_BURST_BENCH=1; the assertions pin the batched shape.
//
// 1. Suppression clear: 20 terminals armed by one suppressResizesDuringProjectSwitch
//    call. Measures how many resetRenderer runs land in the task that fires at
//    durationMs, and that task's wall span with a simulated per-terminal renderer
//    reset cost (a real reset is a WebGL model reset + refresh + fit + reflow).
// 2. Attach reveal: 12 panes attached in one commit. jsdom has no layout, so a
//    (synthetic) forced layout is modelled as a layout read (offsetHeight /
//    getBoundingClientRect) that follows a DOM/style write in the same frame.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

const PRINT = process.env.SWITCH_BURST_BENCH === "1";
const SUPPRESSION_MS = 10_000;
const SWITCH_TERMINALS = 20;
const ATTACH_PANES = 12;
const SIMULATED_RESET_COST_MS = 3;

type BenchService = {
  instances: Map<string, unknown>;
  suppressResizesDuringProjectSwitch: (ids: string[], durationMs: number) => void;
  resetRenderer: (id: string) => boolean;
  attach: (id: string, container: HTMLElement) => unknown;
  resizeController: { fit: (id: string) => void };
  webGLManager: { repairAtlasForReactivation: (id: string) => boolean };
};

function nowMs(): number {
  return performance.now();
}

function busyWait(ms: number): void {
  const end = nowMs() + ms;
  while (nowMs() < end) {
    // simulated renderer work
  }
}

function makeSwitchManaged(id: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 600 });
  (host as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  return {
    id,
    hostElement: host,
    terminal: {
      element: document.createElement("div"),
      modes: { synchronizedOutputMode: false },
      rows: 24,
      refresh: vi.fn(),
      blur: vi.fn(),
    },
    fitAddon: { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) },
    isDetached: false,
    isVisible: true,
    attachGeneration: 1,
    latestCols: 80,
    latestRows: 24,
    isResizeSuppressed: false,
  };
}

// Forced-layout model: a read while `dirty` is a synchronous layout flush.
const layout = { dirty: false, forced: 0, reads: 0 };
function markWrite(): void {
  layout.dirty = true;
}
function markRead(): void {
  layout.reads++;
  if (layout.dirty) {
    layout.forced++;
    layout.dirty = false;
  }
}

function makeAttachManaged(id: string) {
  const hostElement = document.createElement("div");
  const element = document.createElement("div");
  hostElement.appendChild(element);
  return {
    id,
    terminal: {
      blur: vi.fn(),
      // xterm's RenderDebouncer paints on its own next frame; a DOM-renderer
      // paint mutates rows, which dirties layout for any later read.
      refresh: vi.fn(() => {
        requestAnimationFrame(markWrite);
      }),
      dispose: vi.fn(),
      resize: vi.fn(),
      open: vi.fn(),
      element,
      rows: 24,
      buffer: { active: { length: 100 } },
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
    },
    hostElement,
    isOpened: true,
    isDetached: false,
    isVisible: false,
    lastAttachAt: 0,
    lastDetachAt: 0,
    lastWidth: 0,
    lastHeight: 0,
    isAttaching: true,
    attachGeneration: 0,
    attachRevealToken: 0,
    listeners: [],
    exitSubscribers: new Set(),
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
  };
}

describe("project-switch / attach burst benchmark", () => {
  let service: BenchService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BenchService;
      });
    // performance stays real so the simulated reset cost and task spans are wall time.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "Date",
      ],
    });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
    usePanelStore.setState({ focusedId: null });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("suppression clear: resetRenderer runs per task and the firing task's span", async () => {
    const ids = Array.from({ length: SWITCH_TERMINALS }, (_, i) => `t${i}`);
    for (const id of ids) service.instances.set(id, makeSwitchManaged(id));
    const focusedId = ids[13]!;
    usePanelStore.setState({ focusedId });

    vi.spyOn(service.webGLManager, "repairAtlasForReactivation").mockImplementation(() => {
      busyWait(SIMULATED_RESET_COST_MS);
      return true;
    });
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
    const order: string[] = [];
    const reset = service.resetRenderer.bind(service);
    vi.spyOn(service, "resetRenderer").mockImplementation((id: string) => {
      order.push(id);
      return reset(id);
    });

    service.suppressResizesDuringProjectSwitch(ids, SUPPRESSION_MS);

    const t0 = nowMs();
    vi.advanceTimersByTime(SUPPRESSION_MS);
    const firingSpanMs = nowMs() - t0;
    const perTask = [order.length];

    // Drain the continuation of the task that just ran, then run exactly one
    // more timer: each loop iteration is one macrotask plus its microtasks.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const spans = [firingSpanMs];
    await flushMicrotasks();
    perTask[0] = order.length;
    let guard = 0;
    while (order.length < SWITCH_TERMINALS && guard++ < 1000) {
      const before = order.length;
      const t = nowMs();
      vi.advanceTimersToNextTimer();
      await flushMicrotasks();
      if (order.length > before) {
        perTask.push(order.length - before);
        spans.push(nowMs() - t);
      }
    }

    const maxPerTask = Math.max(...perTask);
    const maxSpanMs = Math.max(...spans);
    if (PRINT) {
      process.stdout.write(
        `[switch-burst] resets=${order.length} tasks=${perTask.length} maxPerTask=${maxPerTask} ` +
          `firingTaskSpanMs=${firingSpanMs.toFixed(1)} maxTaskSpanMs=${maxSpanMs.toFixed(1)} focusedIndex=${order.indexOf(focusedId)}\n`
      );
    }

    expect(order.length).toBe(SWITCH_TERMINALS);
    expect(new Set(order).size).toBe(SWITCH_TERMINALS);
    // Chunked: one redraw per task, the focused pane first.
    expect(maxPerTask).toBe(1);
    expect(order[0]).toBe(focusedId);
  });

  it.each([
    { scenario: "cold", warm: false },
    { scenario: "warm", warm: true },
  ])("attach reveal ($scenario): forced layouts across a 12-pane attach", ({ scenario, warm }) => {
    const ids = Array.from({ length: ATTACH_PANES }, (_, i) => `a${i}`);
    const offscreen = document.createElement("div");
    const managedById = new Map<string, ReturnType<typeof makeAttachManaged>>();
    for (const id of ids) {
      const managed = makeAttachManaged(id);
      if (warm) {
        // Switch-back: detached for the switch, same pane size on return.
        managed.isDetached = true;
        managed.lastWidth = 800;
        managed.lastHeight = 600;
      }
      offscreen.appendChild(managed.hostElement);
      service.instances.set(id, managed);
      managedById.set(id, managed);
    }

    // fit() is out of scope for this change: model it as read-then-write.
    vi.spyOn(service.resizeController, "fit").mockImplementation((id: string) => {
      const managed = managedById.get(id);
      managed?.hostElement.getBoundingClientRect();
      markWrite();
    });

    // Hook the prototype that actually owns the accessors on element.style.
    let style: object = Object.getPrototypeOf(document.createElement("div").style) as object;
    while (style && !Object.getOwnPropertyDescriptor(style, "paddingTop")) {
      style = Object.getPrototypeOf(style) as object;
    }
    const paddingDesc = Object.getOwnPropertyDescriptor(style, "paddingTop");
    const opacityDesc = Object.getOwnPropertyDescriptor(style, "opacity");
    expect(paddingDesc?.set).toBeTypeOf("function");
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
      markRead();
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
      } as DOMRect;
    });

    try {
      for (const [name, desc] of [
        ["paddingTop", paddingDesc],
        ["opacity", opacityDesc],
      ] as const) {
        if (!desc?.set) continue;
        Object.defineProperty(style, name, {
          configurable: true,
          get: desc.get,
          set(value: string) {
            markWrite();
            desc.set!.call(this, value);
          },
        });
      }
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get() {
          markRead();
          return 600;
        },
      });

      const containers = ids.map(() => {
        const c = document.createElement("div");
        document.body.appendChild(c);
        return c;
      });
      ids.forEach((id, i) => service.attach(id, containers[i]!));

      // Each frame starts after the rendering step has flushed layout.
      const perFrame: number[] = [];
      layout.forced = 0;
      layout.reads = 0;
      for (let frame = 0; frame < 4; frame++) {
        layout.dirty = false;
        const forcedBefore = layout.forced;
        vi.advanceTimersByTime(16);
        perFrame.push(layout.forced - forcedBefore);
      }

      const fits = vi.mocked(service.resizeController.fit).mock.calls.length;
      if (PRINT) {
        process.stdout.write(
          `[attach-burst ${scenario}] forcedLayouts=${layout.forced} perFrame=${perFrame.join(",")} ` +
            `layoutReads=${layout.reads} fits=${fits}\n`
        );
      }
      for (const managed of managedById.values()) {
        expect(managed.terminal.refresh).toHaveBeenCalledTimes(1);
        expect(managed.isAttaching).toBe(false);
      }
      expect(fits).toBe(warm ? 0 : ATTACH_PANES);
      // One shared reflow flush in frame one; every settle read precedes every
      // fit in frame two (cold fits still read-then-write inside fit()).
      expect(perFrame[0]).toBe(1);
      expect(perFrame[1]).toBe(warm ? 1 : ATTACH_PANES);
    } finally {
      rectSpy.mockRestore();
      if (offsetHeightDesc) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      }
      if (paddingDesc) Object.defineProperty(style, "paddingTop", paddingDesc);
      if (opacityDesc) Object.defineProperty(style, "opacity", opacityDesc);
    }
  });
});
