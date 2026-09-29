// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ITheme } from "@xterm/xterm";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    resize: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: { get: vi.fn(() => new Promise(() => {})) },
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    },
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

const N = 20;
const IDS = Array.from({ length: N }, (_, i) => `perf-global-${i}`);

type Svc = (typeof import("../TerminalInstanceService"))["terminalInstanceService"];

interface Counters {
  fit: number;
  resize: number;
  refresh: number;
  themeSets: number;
}

async function setup() {
  const { terminalInstanceService } = await import("../TerminalInstanceService");
  const { terminalClient } = await import("@/clients");
  const { useTerminalFontStore } = await import("@/store");

  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });

  const { fontSize, fontFamily } = useTerminalFontStore.getState();
  const counters: Counters = { fit: 0, resize: 0, refresh: 0, themeSets: 0 };

  for (const id of IDS) {
    const managed = await terminalInstanceService.getOrCreate(
      id,
      undefined,
      { fontSize, fontFamily },
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    managed.hostElement.checkVisibility = () => true;
    managed.hostElement.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    const origRefresh = managed.terminal.refresh.bind(managed.terminal);
    managed.terminal.refresh = (s: number, e: number) => {
      counters.refresh++;
      origRefresh(s, e);
    };
    // Count effective (non-deduped) theme assignments inside xterm itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    const core = (managed.terminal as any)._core;
    core.optionsService.onSpecificOptionChange("theme", () => {
      counters.themeSets++;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const controller = (terminalInstanceService as any).resizeController;
  const origFit = controller.fit.bind(controller);
  controller.fit = (id: string) => {
    counters.fit++;
    return origFit(id);
  };
  vi.mocked(terminalClient.resize).mockImplementation(() => {
    counters.resize++;
  });

  const reset = () => {
    counters.fit = 0;
    counters.resize = 0;
    counters.refresh = 0;
    counters.themeSets = 0;
  };
  return { svc: terminalInstanceService, counters, reset, fontSize, fontFamily };
}

function report(label: string, c: Counters, extra = "") {
  if (!process.env.DAINTREE_BENCH) return;
  process.stderr.write(
    `[bench] ${label}: fit=${c.fit} resizeRpc=${c.resize} refresh=${c.refresh} themeSets=${c.themeSets}${extra}\n`
  );
}

describe(`applyGlobalOptions cost across ${N} terminals`, () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        accessibility: {
          getEnabled: vi.fn(() => new Promise(() => {})),
          onSupportChanged: vi.fn(() => () => {}),
        },
      },
    });
    ctx = await setup();
    // Settle any fits from creation so counters start clean.
    ctx.svc.applyGlobalOptions({ fontSize: ctx.fontSize, fontFamily: ctx.fontFamily });
    ctx.reset();
  });

  afterEach(() => ctx.reset());

  afterAll(() => {
    for (const id of IDS) ctx.svc.destroy(id);
  });

  it("theme change with unchanged font keys does not refit any terminal", () => {
    const svc: Svc = ctx.svc;
    const theme: ITheme = { foreground: "#fefefe", background: "#010101" };
    const t0 = performance.now();
    svc.applyGlobalOptions({
      theme,
      fontSize: ctx.fontSize,
      fontFamily: ctx.fontFamily,
      screenReaderMode: false,
    });
    const ms = performance.now() - t0;
    report("theme-only global apply", ctx.counters, ` ms=${ms.toFixed(2)}`);

    expect(ctx.counters.fit).toBe(0);
    expect(ctx.counters.resize).toBe(0);
    expect(ctx.counters.themeSets).toBe(N);
    expect(ctx.counters.refresh).toBe(N);

    ctx.reset();
    svc.applyGlobalOptions({ theme, fontSize: ctx.fontSize, fontFamily: ctx.fontFamily });
    expect(ctx.counters.themeSets).toBe(0);
    expect(ctx.counters.refresh).toBe(0);
    expect(ctx.counters.fit).toBe(0);
  });

  it("a real font size change still refits every terminal", () => {
    ctx.svc.applyGlobalOptions({ fontSize: ctx.fontSize + 1, fontFamily: ctx.fontFamily });
    report("font-size change", ctx.counters);
    expect(ctx.counters.fit).toBe(N);
    ctx.reset();
    ctx.svc.applyGlobalOptions({ fontSize: ctx.fontSize, fontFamily: ctx.fontFamily });
    expect(ctx.counters.fit).toBe(N);
  });

  it("theme switch through the adapter and useTerminalConfig paths sets the theme once per terminal", async () => {
    const { useTerminalConfig } = await import("@/hooks/useTerminalConfig");
    const { useTerminalColorSchemeStore, selectEffectiveTheme } =
      await import("@/store/terminalColorSchemeStore");
    const { BUILT_IN_SCHEMES } = await import("@/config/terminalColorSchemes");

    renderHook(() => useTerminalConfig());
    // Mirror XtermAdapter's mounted-terminal path so the mount-time apply is settled.
    const adapterApply = () => {
      const theme = selectEffectiveTheme(useTerminalColorSchemeStore.getState());
      for (const id of IDS) ctx.svc.updateOptions(id, { theme });
    };
    adapterApply();
    ctx.reset();

    const current = useTerminalColorSchemeStore.getState().selectedSchemeId;
    const schemeIds = BUILT_IN_SCHEMES.map((s) => s.id)
      .filter((id) => id !== current)
      .slice(0, 6);
    const totals: Counters = { fit: 0, resize: 0, refresh: 0, themeSets: 0 };
    const t0 = performance.now();
    for (const schemeId of schemeIds) {
      act(() => {
        // XtermAdapter's layout effect runs before useTerminalConfig's passive
        // effect; reproduce that order.
        useTerminalColorSchemeStore.setState({ selectedSchemeId: schemeId });
        adapterApply();
      });
      totals.fit += ctx.counters.fit;
      totals.resize += ctx.counters.resize;
      totals.refresh += ctx.counters.refresh;
      totals.themeSets += ctx.counters.themeSets;
      ctx.reset();
    }
    const ms = performance.now() - t0;
    report(`${schemeIds.length} scheme switches (adapter + hook)`, totals, ` ms=${ms.toFixed(2)}`);

    expect(totals.fit).toBe(0);
    expect(totals.resize).toBe(0);
    expect(totals.themeSets).toBe(schemeIds.length * N);
    expect(totals.refresh).toBe(schemeIds.length * N);
  });
});
