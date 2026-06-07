// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Replace the MRU debounce with a stub whose `flush`/`cancel` are spies, so the
// "flush on hide" wiring (#9914) can be asserted directly without depending on
// the 150ms timer or the focus-subscription chain.
const flushSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cancelSpy = vi.hoisted(() => vi.fn());
vi.mock("@/utils/debounce", () => ({
  debounce: () => {
    const fn = vi.fn() as unknown as {
      (...args: unknown[]): void;
      flush: typeof flushSpy;
      cancel: typeof cancelSpy;
    };
    fn.flush = flushSpy;
    fn.cancel = cancelSpy;
    return fn;
  },
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    onBroadcastResult: vi.fn().mockReturnValue(() => {}),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({ agents: {} }),
    set: vi.fn(),
    reset: vi.fn(),
    stampVersion: vi.fn(),
  },
  cliAvailabilityClient: { refresh: vi.fn() },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/services/SemanticAnalysisService", () => ({
  semanticAnalysisService: { unregisterTerminal: vi.fn() },
}));

const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../rendererStoreOrchestrator");

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("rendererStoreOrchestrator — MRU flush on hide (#9914)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroyStoreOrchestrator();
    initStoreOrchestrator();
  });

  afterEach(() => {
    destroyStoreOrchestrator();
    setHidden(false);
  });

  it("flushes the MRU debounce when the document becomes hidden", () => {
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("does not flush while the document is still visible", () => {
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("removes the visibilitychange listener on destroy — no flush after teardown", () => {
    destroyStoreOrchestrator();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("flushes immediately when the document is already hidden at init", () => {
    // beforeEach init'd while visible; re-init with the document already hidden.
    destroyStoreOrchestrator();
    setHidden(true);
    initStoreOrchestrator();

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});
