/**
 * @vitest-environment jsdom
 */
import React, { Suspense } from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import { XtermAdapter } from "../XtermAdapter";

const mocks = vi.hoisted(() => {
  let keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  let exitHandler: ((exitCode: number) => void) | null = null;

  const managed = {
    terminal: {
      rows: 24,
      cols: 80,
      options: {},
      buffer: {
        active: {
          baseY: 0,
          getLine: () => ({ translateToString: () => "" }),
        },
      },
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        keyHandler = handler;
      }),
    },
    isDetached: false,
    targetCols: undefined,
    targetRows: undefined,
    isAttaching: false,
    isInputLocked: false,
  };

  const terminalInstanceService = {
    getAltBufferState: vi.fn(() => false),
    getOrCreate: vi.fn(() => managed),
    setInputLocked: vi.fn((_id: string, locked: boolean) => {
      managed.isInputLocked = locked;
    }),
    attach: vi.fn(),
    getAttachGeneration: vi.fn(() => 1),
    setVisible: vi.fn(),
    addExitListener: vi.fn((_id: string, handler: (exitCode: number) => void) => {
      exitHandler = handler;
      return vi.fn();
    }),
    resize: vi.fn(() => ({ cols: 80, rows: 24 })),
    get: vi.fn(() => managed),
    flushResize: vi.fn(),
    detach: vi.fn(),
    updateRefreshTierProvider: vi.fn(),
    applyRendererPolicy: vi.fn(),
    boostRefreshRate: vi.fn(),
    addAltBufferListener: vi.fn(() => vi.fn()),
    fetchAndRestore: vi.fn(() => Promise.resolve(false)),
    notifyUserInput: vi.fn(),
    notifyEnterPressed: vi.fn(),
  };

  return {
    effectiveTheme: {},
    managed,
    terminalInstanceService,
    writeTerminalInputOrFleet: vi.fn(),
    useTerminalFileTransfer: vi.fn(),
    getKeyHandler: () => keyHandler,
    getExitHandler: () => exitHandler,
    resetRuntime: () => {
      keyHandler = null;
      exitHandler = null;
      managed.isInputLocked = false;
      managed.isAttaching = false;
      (managed as { keyHandlerInstalled?: boolean }).keyHandlerInstalled = false;
    },
  };
});

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: mocks.terminalInstanceService,
}));

vi.mock("@/services/terminal/fleetInputRouter", () => ({
  writeTerminalInputOrFleet: mocks.writeTerminalInputOrFleet,
}));

vi.mock("../useTerminalFileTransfer", () => ({
  useTerminalFileTransfer: mocks.useTerminalFileTransfer,
}));

vi.mock("@/hooks/useTerminalAppearance", () => ({
  useTerminalAppearance: () => ({
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    performanceMode: false,
    scrollbackLines: 1_000,
    projectScrollback: undefined,
    effectiveTheme: mocks.effectiveTheme,
    wrapperBackground: "rgb(0, 0, 0)",
    screenReaderMode: false,
  }),
}));

vi.mock("@/config/xtermConfig", () => ({
  getXtermOptions: vi.fn(() => ({ cursorBlink: true })),
}));

vi.mock("@/config/terminalFont", () => ({
  terminalFontReady: Object.assign(Promise.resolve(), { status: "fulfilled", value: undefined }),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    normalizeKeyForBinding: vi.fn((event: KeyboardEvent) => event.key),
    getPendingChord: vi.fn(() => null),
    resolveKeybinding: vi.fn(() => ({ shouldConsume: false })),
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

function renderAdapter(props: Partial<React.ComponentProps<typeof XtermAdapter>> = {}) {
  return render(
    <Suspense fallback={null}>
      <XtermAdapter
        terminalId="term-1"
        launchAgentId="claude"
        onReady={vi.fn()}
        onExit={vi.fn()}
        onInput={vi.fn()}
        getRefreshTier={() => TerminalRefreshTier.FOCUSED}
        cwd="/repo/initial"
        {...props}
      />
    </Suspense>
  );
}

describe("XtermAdapter lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetRuntime();

    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      cb(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn() as typeof globalThis.cancelAnimationFrame;
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    } as unknown as typeof ResizeObserver;

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 240,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 120,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not detach and reattach when hot callbacks and runtime props change", async () => {
    const firstOnReady = vi.fn();
    const secondOnReady = vi.fn();
    const firstOnInput = vi.fn();
    const secondOnInput = vi.fn();
    const firstOnExit = vi.fn();
    const secondOnExit = vi.fn();

    const view = renderAdapter({
      onReady: firstOnReady,
      onInput: firstOnInput,
      onExit: firstOnExit,
      cwd: "/repo/initial",
      isInputLocked: false,
      detectedAgentId: "claude",
    });

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));
    expect(firstOnReady).toHaveBeenCalledTimes(1);

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          detectedAgentId="codex"
          isInputLocked={true}
          onReady={secondOnReady}
          onExit={secondOnExit}
          onInput={secondOnInput}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/next"
        />
      </Suspense>
    );

    await waitFor(() =>
      expect(mocks.terminalInstanceService.setInputLocked).toHaveBeenLastCalledWith("term-1", true)
    );

    expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1);
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
    expect(
      mocks.terminalInstanceService.setVisible.mock.calls.some(([, visible]) => visible === false)
    ).toBe(false);
    expect(secondOnReady).not.toHaveBeenCalled();

    const getOrCreateCall = mocks.terminalInstanceService.getOrCreate.mock.calls[0] as
      | unknown[]
      | undefined;
    const cwdProvider = getOrCreateCall?.[5];
    expect(typeof cwdProvider).toBe("function");
    expect((cwdProvider as () => string)()).toBe("/repo/next");
  });

  it("uses the latest input and exit callbacks without reinstalling the terminal", async () => {
    const firstOnInput = vi.fn();
    const secondOnInput = vi.fn();
    const firstOnExit = vi.fn();
    const secondOnExit = vi.fn();

    const view = renderAdapter({
      onInput: firstOnInput,
      onExit: firstOnExit,
      detectedAgentId: "claude",
    });

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          detectedAgentId="codex"
          onInput={secondOnInput}
          onExit={secondOnExit}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/initial"
        />
      </Suspense>
    );

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    const keyHandler = mocks.getKeyHandler();
    expect(keyHandler).toBeTruthy();
    keyHandler?.(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      })
    );

    expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\r");
    expect(firstOnInput).not.toHaveBeenCalled();
    expect(secondOnInput).toHaveBeenCalledWith("\r");
    // Plain Enter must close the synthetic `directing` state explicitly —
    // the custom key handler returns `false` before xterm's onKey/onData
    // fires, bypassing the listener-installed onEnterPressed path (#8255).
    expect(mocks.terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
    expect(mocks.terminalInstanceService.notifyEnterPressed).toHaveBeenCalledWith("term-1");

    mocks.getExitHandler()?.(7);
    expect(firstOnExit).not.toHaveBeenCalled();
    expect(secondOnExit).toHaveBeenCalledWith(7);
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
  });

  it("re-applies renderer policy when a stable tier provider returns a new tier", async () => {
    let tier = TerminalRefreshTier.BACKGROUND;
    const getRefreshTier = vi.fn(() => tier);

    const view = renderAdapter({ getRefreshTier });

    await waitFor(() =>
      expect(mocks.terminalInstanceService.applyRendererPolicy).toHaveBeenLastCalledWith(
        "term-1",
        TerminalRefreshTier.BACKGROUND
      )
    );

    mocks.terminalInstanceService.applyRendererPolicy.mockClear();
    tier = TerminalRefreshTier.VISIBLE;

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          onReady={vi.fn()}
          onExit={vi.fn()}
          onInput={vi.fn()}
          getRefreshTier={getRefreshTier}
          cwd="/repo/initial"
        />
      </Suspense>
    );

    await waitFor(() =>
      expect(mocks.terminalInstanceService.applyRendererPolicy).toHaveBeenLastCalledWith(
        "term-1",
        TerminalRefreshTier.VISIBLE
      )
    );
    expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1);
  });
});
