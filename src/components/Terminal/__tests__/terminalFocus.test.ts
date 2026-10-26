import { describe, it, expect } from "vitest";
import {
  getTerminalFocusTarget,
  isLikelyAtSynthesizedPointer,
  resolvePaneFocusAction,
  resolveTerminalPaneFocus,
  shouldShowHybridInputBar,
  shouldSuppressUnfocusedClick,
} from "../terminalFocus";

/**
 * The selection guard used to be unconditional: any selection in the pane's
 * xterm cancelled the focus handoff outright. That stranded the keyboard on the
 * pane the user had just left whenever the destination happened to be holding an
 * old selection — highlight on one pane, keystrokes into another (#11133).
 */
describe("resolveTerminalPaneFocus", () => {
  const pane = {
    hasHybridInputSurface: true,
    isInputDisabled: false,
    hybridInputEnabled: true,
    hasSelection: false,
    xtermOwnsDomFocus: false,
  };

  it.each([
    ["hybridInput", "xterm", "hybridInput"],
    ["xterm", "hybridInput", "xterm"],
    [null, "hybridInput", "hybridInput"],
    [null, "xterm", "xterm"],
  ] as const)("asked for %s with home %s, goes to %s", (requested, home, action) => {
    expect(resolveTerminalPaneFocus({ ...pane, requested, home })).toBe(action);
  });

  it("sends a requested hybrid input the pane can't take to the terminal", () => {
    expect(
      resolveTerminalPaneFocus({
        ...pane,
        requested: "hybridInput",
        home: "hybridInput",
        isInputDisabled: true,
      })
    ).toBe("xterm");
  });

  // An xterm holding the keyboard and a selection keeps both for the pane's own
  // pick, but not against a caller that named the hybrid input.
  it.each([
    ["hybridInput", "hybridInput"],
    [null, "preserve"],
  ] as const)("asked for %s past an owned xterm selection, does %s", (requested, action) => {
    expect(
      resolveTerminalPaneFocus({
        ...pane,
        requested,
        home: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: true,
      })
    ).toBe(action);
  });
});

/**
 * The issue #14689 table. Home is the **Focus first** setting;
 * nothing a pane remembers, so every row is the same whatever the pane, or the
 * pane before it, did last.
 */
describe("where an agent pane puts the keyboard", () => {
  const available = {
    hasHybridInputSurface: true,
    isInputDisabled: false,
    hybridInputEnabled: true,
    hasSelection: false,
  };
  const homes = ["hybridInput", "xterm"] as const;
  // The pane's own pass, as it becomes selected or what it can take changes.
  const ownPass = (options: {
    home: "hybridInput" | "xterm";
    owned?: "hybridInput" | "xterm" | null;
    isInputDisabled?: boolean;
    hasHybridInputSurface?: boolean;
    hasSelection?: boolean;
  }) =>
    resolveTerminalPaneFocus({
      ...available,
      requested: null,
      home: options.home,
      hasSelection: options.hasSelection ?? false,
      isInputDisabled: options.isInputDisabled ?? false,
      hasHybridInputSurface: options.hasHybridInputSurface ?? true,
      xtermOwnsDomFocus: options.owned === "xterm",
      hybridInputOwnsDomFocus: options.owned === "hybridInput",
      keepOwnedSurface: true,
    });

  it.each(homes)(
    "lands an arrival on home %s, wherever the keyboard was in the pane it left",
    (home) => {
      // Cmd+Opt+Arrow, Cmd+1-9, a launch: the keyboard is in another pane, or
      // on a button, so neither of this pane's surfaces holds it.
      expect(ownPass({ home })).toBe(home);
      // Tab switch, `panel.focus`, Enter from the grid: the registry, which
      // keeps nothing.
      for (const xtermOwnsDomFocus of [true, false]) {
        expect(
          resolveTerminalPaneFocus({ ...available, requested: null, home, xtermOwnsDomFocus })
        ).toBe(home);
      }
    }
  );

  it.each(homes)(
    "activates an unfocused pane on a terminal click and lands on home %s, grid and dock alike",
    (home) => {
      // The click is swallowed before xterm takes the keyboard, so the pane's
      // own pass finds nothing owned.
      expect(
        shouldSuppressUnfocusedClick({
          isFocused: false,
          isCursorPointer: false,
          isShiftKey: false,
        })
      ).toBe(true);
      expect(ownPass({ home, owned: null })).toBe(home);
    }
  );

  it.each(homes)("keeps a click into the hybrid input on the hybrid input with home %s", (home) => {
    // The editor takes the keyboard on the press, before the click selects
    // the pane, and for a pane already selected no pass runs at all.
    expect(ownPass({ home, owned: "hybridInput" })).toBe("preserve");
  });

  it.each(homes)("lets a click on the focused pane's terminal reach xterm with home %s", (home) => {
    expect(
      shouldSuppressUnfocusedClick({ isFocused: true, isCursorPointer: false, isShiftKey: false })
    ).toBe(false);
    // A later pass on the same pane, its input bar appearing or unlocking,
    // leaves the keyboard on the terminal the user is typing in.
    expect(ownPass({ home, owned: "xterm" })).toBe("preserve");
  });

  it.each(homes)(
    "falls back to the terminal with home %s when the hybrid input is missing or disabled",
    (home) => {
      expect(ownPass({ home, hasHybridInputSurface: false })).toBe("xterm");
      expect(ownPass({ home, isInputDisabled: true })).toBe("xterm");
      // A keyboard left on an input bar that just locked doesn't keep it.
      expect(ownPass({ home, owned: "hybridInput", isInputDisabled: true })).toBe("xterm");
    }
  );

  it("still hands an inert selection's pane to home", () => {
    // #11133: a selection in an xterm that doesn't hold the keyboard is no
    // reason to strand the keyboard on the pane the user just left.
    expect(ownPass({ home: "hybridInput", hasSelection: true })).toBe("hybridInput");
  });

  // A drop, type-anywhere, a search restore, a send's hand-back to the
  // terminal (#14692): the surface a caller named wins over home and over
  // whichever of the pane's surfaces holds the keyboard.
  it.each([
    ["xterm", "hybridInput", "hybridInput"],
    ["xterm", "xterm", "hybridInput"],
    ["hybridInput", "hybridInput", "xterm"],
    ["hybridInput", "xterm", "xterm"],
  ] as const)(
    "lets a caller that named %s with home %s past the keyboard on the %s",
    (requested, home, owned) => {
      expect(
        resolveTerminalPaneFocus({
          ...available,
          requested,
          home,
          xtermOwnsDomFocus: owned === "xterm",
          hybridInputOwnsDomFocus: owned === "hybridInput",
          keepOwnedSurface: true,
        })
      ).toBe(requested);
    }
  );
});

describe("resolvePaneFocusAction", () => {
  // Preserving would report a handoff to the named surface that never happened.
  it("takes the hybrid input past an xterm selection when a caller asked for it", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: true,
        requested: true,
      })
    ).toBe("hybridInput");
  });

  it("keeps focus in xterm when it holds both the selection and the keyboard", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: true,
      })
    ).toBe("preserve");
  });

  it("hands off to the input bar when the selection sits in an unfocused xterm", () => {
    // The pane is being focused from somewhere else, so this xterm is already
    // blurred — its selection is inert and cannot be disturbed by the handoff.
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: false,
      })
    ).toBe("hybridInput");
  });

  it("hands off to the input bar when xterm has focus but no selection", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: false,
        xtermOwnsDomFocus: true,
      })
    ).toBe("hybridInput");
  });

  it("hands off to the input bar when the pane holds neither", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: false,
        xtermOwnsDomFocus: false,
      })
    ).toBe("hybridInput");
  });

  it("never preserves when the resolved target is xterm itself", () => {
    // A selection is not a reason to skip focusing xterm — that would leave the
    // keyboard wherever it was.
    for (const hasSelection of [true, false]) {
      for (const xtermOwnsDomFocus of [true, false]) {
        expect(
          resolvePaneFocusAction({ focusTarget: "xterm", hasSelection, xtermOwnsDomFocus })
        ).toBe("xterm");
      }
    }
  });
});

describe("shouldShowHybridInputBar", () => {
  it("shows for agent terminals when enabled", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: true,
        hybridInputEnabled: true,
        isFleetArmed: false,
        fleetSize: 0,
      })
    ).toBe(true);
  });

  it("shows for normal terminals only while they are in a 2+ Fleet", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: false,
        hybridInputEnabled: true,
        isFleetArmed: true,
        fleetSize: 2,
      })
    ).toBe(true);
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: false,
        hybridInputEnabled: true,
        isFleetArmed: true,
        fleetSize: 1,
      })
    ).toBe(false);
  });

  it("hides when hybrid input is disabled", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: true,
        hybridInputEnabled: false,
        isFleetArmed: true,
        fleetSize: 2,
      })
    ).toBe(false);
  });
});

describe("getTerminalFocusTarget", () => {
  it("honors a hybridInput target when the surface is available", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("hybridInput");
  });

  it("honors an xterm target even when the surface exists", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "xterm",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when input is disabled despite a hybridInput target", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: true,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when no hybrid input surface is mounted", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: false,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when hybrid input is disabled globally", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: false,
      })
    ).toBe("xterm");
  });
});

describe("shouldSuppressUnfocusedClick", () => {
  it("suppresses an unfocused pane's click on a non-pointer cell", () => {
    expect(
      shouldSuppressUnfocusedClick({
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(true);
  });

  it("does not suppress when the pane is already focused — the click should pass through to xterm", () => {
    expect(
      shouldSuppressUnfocusedClick({
        isFocused: true,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("does not suppress on link/cursor-pointer cells so the link click registers", () => {
    expect(
      shouldSuppressUnfocusedClick({
        isFocused: false,
        isCursorPointer: true,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("does not suppress shift+click — xterm uses shift to bypass PTY mouse reporting for native selection", () => {
    expect(
      shouldSuppressUnfocusedClick({
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: true,
      })
    ).toBe(false);
  });
});

describe("shouldSuppressUnfocusedClick option-click", () => {
  const base = { isFocused: false, isCursorPointer: false, isShiftKey: false };

  it("does not suppress option+click on macOS — xterm's force-selection gesture there", () => {
    expect(shouldSuppressUnfocusedClick({ ...base, isAltKey: true, isMac: true })).toBe(false);
  });

  it("still suppresses alt+click off macOS, where alt does not force selection", () => {
    expect(shouldSuppressUnfocusedClick({ ...base, isAltKey: true, isMac: false })).toBe(true);
  });

  it("still suppresses a plain click on macOS", () => {
    expect(shouldSuppressUnfocusedClick({ ...base, isAltKey: false, isMac: true })).toBe(true);
  });

  it("keeps link cells exempt regardless of option", () => {
    expect(
      shouldSuppressUnfocusedClick({ ...base, isCursorPointer: true, isAltKey: false, isMac: true })
    ).toBe(false);
  });
});

describe("isLikelyAtSynthesizedPointer", () => {
  it("treats a pointerdown with no recorded move as AT-synthesized", () => {
    expect(isLikelyAtSynthesizedPointer(null, 1000)).toBe(true);
  });

  it("treats a click shortly after a move as a physical pointer", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1050)).toBe(false);
  });

  it("treats a move exactly at the threshold as physical (boundary, inclusive)", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1100)).toBe(false);
  });

  it("treats a click more than the threshold after the last move as AT-synthesized", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1101)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1030, 20)).toBe(true);
    expect(isLikelyAtSynthesizedPointer(1000, 1010, 20)).toBe(false);
  });
});
