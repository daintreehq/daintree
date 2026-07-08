// @vitest-environment jsdom
//
// Set-side coverage for #10632 rule #1: the project-switch suppression-clear
// must PRESERVE the guaranteed-redraw obligation whenever the redraw did not
// actually run — not only when the host is `isDetached`. This drives the REAL
// `suppressResizesDuringProjectSwitch` (where the original gap lived) rather
// than seeding `revealPendingRepair` by hand, so the branch logic at the fire
// site is exercised. Discharge-on-foreground is covered by the watchdog
// regression suite (TerminalSwitchBackRedraw.regression.test.ts, path B).
//
// The "attached-but-occluded" and "renderable-but-sub-50px" cases FAIL against
// the pre-fix logic (`else if (instance.isDetached)`): there the obligation was
// silently spent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
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

const SUPPRESSION_MS = 10_000;

type ObligationService = {
  instances: Map<string, unknown>;
  suppressResizesDuringProjectSwitch: (ids: string[], durationMs: number) => void;
  resetRenderer: (id: string) => boolean;
};

interface HostConfig {
  connected: boolean;
  clientWidth: number;
  clientHeight: number;
  checkVisibility?: boolean;
}

function makeHost(cfg: HostConfig): HTMLDivElement {
  const host = document.createElement("div");
  if (cfg.connected) document.body.appendChild(host);
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => cfg.clientWidth });
  Object.defineProperty(host, "clientHeight", { configurable: true, get: () => cfg.clientHeight });
  if (cfg.checkVisibility !== undefined) {
    (host as unknown as { checkVisibility: () => boolean }).checkVisibility = () =>
      cfg.checkVisibility === true;
  }
  return host;
}

function makeManaged(id: string, host: HTMLDivElement, isDetached: boolean) {
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
    isDetached,
    isVisible: !isDetached,
    attachGeneration: 7,
    latestCols: 80,
    latestRows: 24,
    resizeSuppressionTimer: undefined as number | undefined,
    resizeSuppressionEndTime: undefined as number | undefined,
    isResizeSuppressed: false,
    revealPendingRepair: undefined as boolean | undefined,
    revealPendingGeneration: undefined as number | undefined,
  };
}

describe("#10632 rule #1 — suppression-clear preserves the redraw obligation", () => {
  let service: ObligationService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ObligationService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("arms the obligation when the host is detached at fire time", () => {
    const host = makeHost({ connected: false, clientWidth: 0, clientHeight: 0 });
    const managed = makeManaged("detached", host, /* isDetached */ true);
    service.instances.set("detached", managed);
    const resetSpy = vi.spyOn(service, "resetRenderer");

    service.suppressResizesDuringProjectSwitch(["detached"], SUPPRESSION_MS);
    vi.advanceTimersByTime(SUPPRESSION_MS);

    expect(resetSpy).not.toHaveBeenCalled(); // not renderable → not spent
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(7);
  });

  it("arms the obligation when the host is ATTACHED-but-occluded (zero box) — the pre-fix dead zone", () => {
    // isDetached === false, isConnected === true, but zero layout box (occluded
    // behind the warm bridge). hostHasRenderableDims is false; the old logic's
    // `else if (instance.isDetached)` would NOT fire here, silently spending the
    // obligation. This assertion FAILS on the pre-fix branch.
    const host = makeHost({ connected: true, clientWidth: 0, clientHeight: 0 });
    const managed = makeManaged("occluded", host, /* isDetached */ false);
    service.instances.set("occluded", managed);
    const resetSpy = vi.spyOn(service, "resetRenderer");

    service.suppressResizesDuringProjectSwitch(["occluded"], SUPPRESSION_MS);
    vi.advanceTimersByTime(SUPPRESSION_MS);

    expect(resetSpy).not.toHaveBeenCalled();
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(7);
  });

  it("arms the obligation when the host is renderable but below the >=50px floor — resetRenderer self-skips", () => {
    // hostHasRenderableDims is TRUE (nonzero box, visible), so resetRenderer runs
    // — but self-skips on its >=50px guard and returns false. The obligation must
    // still be carried. This also FAILS on the pre-fix logic, where resetRenderer
    // returned void and no flag was set.
    const host = makeHost({
      connected: true,
      clientWidth: 40,
      clientHeight: 40,
      checkVisibility: true,
    });
    const managed = makeManaged("tiny", host, /* isDetached */ false);
    service.instances.set("tiny", managed);
    const resetSpy = vi.spyOn(service, "resetRenderer");

    service.suppressResizesDuringProjectSwitch(["tiny"], SUPPRESSION_MS);
    vi.advanceTimersByTime(SUPPRESSION_MS);

    expect(resetSpy).toHaveBeenCalledWith("tiny");
    expect(resetSpy.mock.results[0]?.value).toBe(false); // ran but self-skipped → not spent
    expect(managed.revealPendingRepair).toBe(true);
    expect(managed.revealPendingGeneration).toBe(7);
  });

  it("runs the redraw and does NOT arm an obligation when the host is foreground-renderable", () => {
    const host = makeHost({
      connected: true,
      clientWidth: 800,
      clientHeight: 600,
      checkVisibility: true,
    });
    const managed = makeManaged("visible", host, /* isDetached */ false);
    service.instances.set("visible", managed);
    const resetSpy = vi.spyOn(service, "resetRenderer");

    service.suppressResizesDuringProjectSwitch(["visible"], SUPPRESSION_MS);
    vi.advanceTimersByTime(SUPPRESSION_MS);

    expect(resetSpy).toHaveBeenCalledWith("visible");
    expect(resetSpy.mock.results[0]?.value).toBe(true); // redraw actually ran
    expect(managed.revealPendingRepair).toBeUndefined(); // nothing owed
  });
});
