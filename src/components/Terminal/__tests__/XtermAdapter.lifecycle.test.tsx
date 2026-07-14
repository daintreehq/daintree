/**
 * @vitest-environment jsdom
 */
import React, { Suspense } from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { XtermAdapter } from "../XtermAdapter";

const mocks = vi.hoisted(() => {
  let keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  let exitHandler: ((exitCode: number) => void) | null = null;
  const platform = { isMac: true };

  const defaultAppearance = {
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    performanceMode: false,
    scrollbackLines: 1_000,
    projectScrollback: undefined as number | undefined,
    wrapperBackground: "rgb(0, 0, 0)",
    screenReaderMode: false,
  };
  const appearance = { ...defaultAppearance, effectiveTheme: {} as object };

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
    updateOptions: vi.fn(),
    updateRefreshTierProvider: vi.fn(),
    applyRendererPolicy: vi.fn(),
    boostRefreshRate: vi.fn(),
    addAltBufferListener: vi.fn(() => vi.fn()),
    fetchAndRestore: vi.fn(() => Promise.resolve(false)),
    notifyUserInput: vi.fn(),
    notifyEnterPressed: vi.fn(),
  };

  return {
    appearance,
    managed,
    platform,
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
      platform.isMac = true;
      // vi.clearAllMocks() drops calls but keeps implementations, so a test that
      // switches to the alt buffer would otherwise leak into the next one.
      terminalInstanceService.getAltBufferState.mockReturnValue(false);
      Object.assign(appearance, defaultAppearance, { effectiveTheme: {} });
    },
  };
});

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => mocks.platform.isMac,
}));

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
  // Reads the mutable appearance object so tests can change appearance values
  // between rerenders (#9929 regression coverage).
  useTerminalAppearance: () => ({ ...mocks.appearance }),
}));

vi.mock("@/config/xtermConfig", () => ({
  getXtermOptions: vi.fn(
    (config: {
      fontSize: number;
      fontFamily: string;
      scrollback: number;
      theme?: object;
      screenReaderMode?: boolean;
    }) => ({
      cursorBlink: true,
      fontSize: config.fontSize,
      fontFamily: config.fontFamily,
      theme: config.theme,
      scrollback: config.scrollback,
      screenReaderMode: config.screenReaderMode ?? false,
    })
  ),
}));

vi.mock("@/config/terminalFont", () => ({
  DEFAULT_TERMINAL_FONT_FAMILY: "monospace",
  DEFAULT_TERMINAL_FONT_SIZE: 12,
  ensureTerminalFontLoaded: () => Promise.resolve(),
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

  it("keeps Tab and Shift+Tab as xterm-owned input without dispatching focus-region actions (#9082)", async () => {
    renderAdapter();
    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    const keyHandler = mocks.getKeyHandler();
    expect(keyHandler).toBeTruthy();

    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(tabEvent, "preventDefault");
    const stopPropagationSpy = vi.spyOn(tabEvent, "stopPropagation");
    const tabResult = keyHandler?.(tabEvent);
    expect(tabResult).toBe(true);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();

    const shiftTabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const shiftTabPreventDefaultSpy = vi.spyOn(shiftTabEvent, "preventDefault");
    const shiftTabStopPropagationSpy = vi.spyOn(shiftTabEvent, "stopPropagation");
    const shiftTabResult = keyHandler?.(shiftTabEvent);
    expect(shiftTabResult).toBe(true);
    expect(shiftTabPreventDefaultSpy).toHaveBeenCalled();
    expect(shiftTabStopPropagationSpy).toHaveBeenCalled();

    // Held Tab (key-repeat) must also pass through — shell autocomplete and
    // many TUIs rely on sustained Tab presses.
    const repeatedTabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    const repeatedTabPreventDefaultSpy = vi.spyOn(repeatedTabEvent, "preventDefault");
    const repeatedTabStopPropagationSpy = vi.spyOn(repeatedTabEvent, "stopPropagation");
    const repeatedTabResult = keyHandler?.(repeatedTabEvent);
    expect(repeatedTabResult).toBe(true);
    expect(repeatedTabPreventDefaultSpy).toHaveBeenCalled();
    expect(repeatedTabStopPropagationSpy).toHaveBeenCalled();

    expect(actionService.dispatch).not.toHaveBeenCalled();
  });

  it("captures bare F11 so Electron's fullscreen accelerator does not fire (#9104)", async () => {
    // The regression condition is xterm v6's screen-reader mode, which skips
    // its internal preventDefault on handled keys and lets F11 bubble to the
    // Electron menu accelerator. The guard itself is unconditional, so this
    // test exercises the same handler path regardless of screenReaderMode.
    renderAdapter();
    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    const keyHandler = mocks.getKeyHandler();
    expect(keyHandler).toBeTruthy();

    const f11Event = new KeyboardEvent("keydown", {
      key: "F11",
      code: "F11",
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(f11Event, "preventDefault");
    const stopPropagationSpy = vi.spyOn(f11Event, "stopPropagation");
    const f11Result = keyHandler?.(f11Event);
    expect(f11Result).toBe(true);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();

    // F11 with modifiers must still reach TUIs that bind them (e.g. Ctrl+F11).
    const ctrlF11Event = new KeyboardEvent("keydown", {
      key: "F11",
      code: "F11",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const ctrlPreventDefaultSpy = vi.spyOn(ctrlF11Event, "preventDefault");
    const ctrlStopPropagationSpy = vi.spyOn(ctrlF11Event, "stopPropagation");
    keyHandler?.(ctrlF11Event);
    expect(ctrlPreventDefaultSpy).not.toHaveBeenCalled();
    expect(ctrlStopPropagationSpy).not.toHaveBeenCalled();

    const shiftF11Event = new KeyboardEvent("keydown", {
      key: "F11",
      code: "F11",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const shiftPreventDefaultSpy = vi.spyOn(shiftF11Event, "preventDefault");
    const shiftStopPropagationSpy = vi.spyOn(shiftF11Event, "stopPropagation");
    keyHandler?.(shiftF11Event);
    expect(shiftPreventDefaultSpy).not.toHaveBeenCalled();
    expect(shiftStopPropagationSpy).not.toHaveBeenCalled();

    // Some input methods report key="Unidentified" with code/keyCode intact.
    // xterm still emits F11 to the PTY via keyCode 122, so the guard must too.
    const unidentifiedF11Event = new KeyboardEvent("keydown", {
      key: "Unidentified",
      code: "F11",
      keyCode: 122,
      bubbles: true,
      cancelable: true,
    });
    const unidentifiedPreventDefaultSpy = vi.spyOn(unidentifiedF11Event, "preventDefault");
    const unidentifiedStopPropagationSpy = vi.spyOn(unidentifiedF11Event, "stopPropagation");
    const unidentifiedResult = keyHandler?.(unidentifiedF11Event);
    expect(unidentifiedResult).toBe(true);
    expect(unidentifiedPreventDefaultSpy).toHaveBeenCalled();
    expect(unidentifiedStopPropagationSpy).toHaveBeenCalled();

    expect(actionService.dispatch).not.toHaveBeenCalled();
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

  it("applies theme changes in-place without detaching or reattaching (#9929)", async () => {
    const view = renderAdapter();

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));
    // Mount applies options through getOrCreate — no redundant updateOptions
    // call. (The real getOrCreate routes existing instances through
    // updateOptions internally; the adapter records what it passed to
    // getOrCreate as applied, which is what keeps this assertion valid with
    // the simplified mock.)
    expect(mocks.terminalInstanceService.updateOptions).not.toHaveBeenCalled();

    const newTheme = { background: "#ff0000" };
    mocks.appearance.effectiveTheme = newTheme;

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          onReady={vi.fn()}
          onExit={vi.fn()}
          onInput={vi.fn()}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/initial"
        />
      </Suspense>
    );

    // Theme-only change forwards exactly the theme key — including unchanged
    // fontSize/fontFamily would trigger a refit of every mounted terminal.
    await waitFor(() =>
      expect(mocks.terminalInstanceService.updateOptions).toHaveBeenCalledWith("term-1", {
        theme: newTheme,
      })
    );
    expect(mocks.terminalInstanceService.updateOptions).toHaveBeenCalledTimes(1);

    // The attach lifecycle must not re-run: no detach (which blurs the focused
    // terminal), no re-attach, no visibility flicker, no instance re-creation.
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
    expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1);
    expect(mocks.terminalInstanceService.getOrCreate).toHaveBeenCalledTimes(1);
    expect(
      mocks.terminalInstanceService.setVisible.mock.calls.some(([, visible]) => visible === false)
    ).toBe(false);

    // Real unmount still tears down through detach exactly once.
    view.unmount();
    expect(mocks.terminalInstanceService.detach).toHaveBeenCalledTimes(1);
  });

  it("applies font size changes via updateOptions without an attach cycle (#9929)", async () => {
    const view = renderAdapter();

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    mocks.appearance.fontSize = 16;

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          onReady={vi.fn()}
          onExit={vi.fn()}
          onInput={vi.fn()}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/initial"
        />
      </Suspense>
    );

    await waitFor(() =>
      expect(mocks.terminalInstanceService.updateOptions).toHaveBeenCalledWith("term-1", {
        fontSize: 16,
      })
    );
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
    expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1);
  });

  it("does not call updateOptions when appearance is unchanged across rerenders (#9929)", async () => {
    const view = renderAdapter();

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          onReady={vi.fn()}
          onExit={vi.fn()}
          onInput={vi.fn()}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/next"
        />
      </Suspense>
    );

    expect(mocks.terminalInstanceService.updateOptions).not.toHaveBeenCalled();
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
    expect(mocks.terminalInstanceService.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("batches simultaneous appearance changes into a single delta call (#9929)", async () => {
    const view = renderAdapter();

    await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));

    const newTheme = { background: "#00ff00" };
    mocks.appearance.effectiveTheme = newTheme;
    mocks.appearance.fontSize = 18;

    view.rerender(
      <Suspense fallback={null}>
        <XtermAdapter
          terminalId="term-1"
          launchAgentId="claude"
          onReady={vi.fn()}
          onExit={vi.fn()}
          onInput={vi.fn()}
          getRefreshTier={() => TerminalRefreshTier.FOCUSED}
          cwd="/repo/initial"
        />
      </Suspense>
    );

    await waitFor(() =>
      expect(mocks.terminalInstanceService.updateOptions).toHaveBeenCalledWith("term-1", {
        theme: newTheme,
        fontSize: 18,
      })
    );
    expect(mocks.terminalInstanceService.updateOptions).toHaveBeenCalledTimes(1);
    expect(mocks.terminalInstanceService.detach).not.toHaveBeenCalled();
  });

  describe("Option+Arrow word navigation (#11154)", () => {
    beforeEach(() => {
      // vi.clearAllMocks() keeps implementations and queued `Once` values, so the
      // chord tests below would otherwise bleed into each other. mockReset drops
      // both; re-establish the pass-through defaults.
      vi.mocked(keybindingService.getPendingChord).mockReset().mockReturnValue(null);
      vi.mocked(keybindingService.resolveKeybinding)
        .mockReset()
        .mockReturnValue({ shouldConsume: false });
    });

    async function mountAndGetKeyHandler(props: Parameters<typeof renderAdapter>[0] = {}) {
      renderAdapter(props);
      await waitFor(() => expect(mocks.terminalInstanceService.attach).toHaveBeenCalledTimes(1));
      const keyHandler = mocks.getKeyHandler();
      expect(keyHandler).toBeTruthy();
      return keyHandler!;
    }

    function optionArrow(key: "ArrowLeft" | "ArrowRight", init: KeyboardEventInit = {}) {
      return new KeyboardEvent("keydown", {
        key,
        code: key,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      });
    }

    it("writes the backward-word sequence for Option+Left", async () => {
      const onInput = vi.fn();
      const keyHandler = await mountAndGetKeyHandler({ onInput });

      const event = optionArrow("ArrowLeft");
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      const stopPropagationSpy = vi.spyOn(event, "stopPropagation");

      // `false` suppresses xterm's own CSI modifier arrow, which readline ignores.
      expect(keyHandler(event)).toBe(false);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\x1bb");
      // `return false` bypasses xterm's onData, so input tracking is replicated here.
      expect(mocks.terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
      expect(onInput).toHaveBeenCalledWith("\x1bb");
    });

    it("writes the forward-word sequence for Option+Right", async () => {
      const onInput = vi.fn();
      const keyHandler = await mountAndGetKeyHandler({ onInput });

      expect(keyHandler(optionArrow("ArrowRight"))).toBe(false);
      expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\x1bf");
      expect(onInput).toHaveBeenCalledWith("\x1bf");
    });

    it("keeps writing while the key is held", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      // The shared `event.repeat` early return would otherwise hand repeats back
      // to xterm, so a held Option+Left would jump one word and then stall.
      expect(keyHandler(optionArrow("ArrowLeft", { repeat: true }))).toBe(false);
      expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\x1bb");
    });

    it("keeps a held Option+Arrow out of the chord state machine", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      // A chord IS pending and would consume the key — an auto-repeat must not
      // reach it, or a held arrow completes a chord the user never re-pressed.
      vi.mocked(keybindingService.getPendingChord).mockReturnValue("Cmd+K");
      vi.mocked(keybindingService.resolveKeybinding).mockReturnValue({ shouldConsume: true });

      expect(keyHandler(optionArrow("ArrowLeft", { repeat: true }))).toBe(false);

      expect(keybindingService.getPendingChord).not.toHaveBeenCalled();
      expect(keybindingService.resolveKeybinding).not.toHaveBeenCalled();
      expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\x1bb");
    });

    it("leaves Option+Arrow to a full-screen TUI on the alt buffer", async () => {
      const onInput = vi.fn();
      const keyHandler = await mountAndGetKeyHandler({ onInput });

      // Flipped after the handler is installed: the handler is installed once, so
      // reading the buffer mode at install time would silently freeze it.
      mocks.terminalInstanceService.getAltBufferState.mockReturnValue(true);

      // A TUI decodes xterm's CSI modifier arrow itself; rewriting it would hand
      // the app a Meta+B/F instead of the Alt+Arrow it bound.
      expect(keyHandler(optionArrow("ArrowLeft"))).toBe(true);
      expect(keyHandler(optionArrow("ArrowRight", { repeat: true }))).toBe(true);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();

      // ...and word jump resumes when the TUI exits back to the shell.
      mocks.terminalInstanceService.getAltBufferState.mockReturnValue(false);
      expect(keyHandler(optionArrow("ArrowLeft"))).toBe(false);
      expect(mocks.writeTerminalInputOrFleet).toHaveBeenCalledWith("term-1", "\x1bb");
    });

    it("leaves Option+Arrow to xterm's composition handling during IME input", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      expect(keyHandler(optionArrow("ArrowLeft", { isComposing: true }))).toBe(true);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
    });

    it("leaves Option+Arrow to xterm off macOS, including on repeat", async () => {
      mocks.platform.isMac = false;
      const onInput = vi.fn();
      const keyHandler = await mountAndGetKeyHandler({ onInput });

      expect(keyHandler(optionArrow("ArrowLeft"))).toBe(true);
      expect(keyHandler(optionArrow("ArrowRight", { repeat: true }))).toBe(true);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
      expect(mocks.terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
    });

    it("does not claim Option+Arrow combined with another modifier", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      // Shift+Option extends a selection; Cmd+Option is bound to terminal.focus*.
      keyHandler(optionArrow("ArrowLeft", { shiftKey: true }));
      keyHandler(optionArrow("ArrowRight", { ctrlKey: true }));
      keyHandler(optionArrow("ArrowLeft", { metaKey: true }));

      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
      expect(mocks.terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
    });

    it("leaves unmodified arrows to xterm", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      const plainArrow = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        code: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      });
      expect(keyHandler(plainArrow)).toBe(true);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
    });

    it("swallows Option+Arrow without writing while input is locked", async () => {
      const onInput = vi.fn();
      const keyHandler = await mountAndGetKeyHandler({ isInputLocked: true, onInput });
      mocks.managed.isInputLocked = true;

      expect(keyHandler(optionArrow("ArrowLeft"))).toBe(false);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
      expect(mocks.terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
    });

    it("lets a pending chord consume Option+Arrow before word navigation", async () => {
      const keyHandler = await mountAndGetKeyHandler();

      vi.mocked(keybindingService.getPendingChord).mockReturnValueOnce("Cmd+K");
      vi.mocked(keybindingService.resolveKeybinding).mockReturnValueOnce({ shouldConsume: true });

      expect(keyHandler(optionArrow("ArrowLeft"))).toBe(false);
      expect(mocks.writeTerminalInputOrFleet).not.toHaveBeenCalled();
    });
  });
});
