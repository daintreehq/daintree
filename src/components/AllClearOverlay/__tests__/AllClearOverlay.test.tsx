// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ALL_CLEAR_FLASH_DURATION } from "@/lib/animationUtils";
import { AllClearOverlay } from "../AllClearOverlay";

const OVERLAY_SELECTOR = "[aria-hidden='true']";

type AllClearPayload = { timestamp: number; shouldFlash: boolean };

let onAllAgentsClearCb: ((data: AllClearPayload) => void) | null = null;

function fireAllClear(shouldFlash = true) {
  onAllAgentsClearCb?.({ timestamp: Date.now(), shouldFlash });
}

beforeEach(() => {
  vi.useFakeTimers();
  onAllAgentsClearCb = null;

  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      terminal: {
        onAllAgentsClear: vi.fn((callback: (data: AllClearPayload) => void) => {
          onAllAgentsClearCb = callback;
          return () => {
            onAllAgentsClearCb = null;
          };
        }),
      },
    },
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AllClearOverlay", () => {
  it("renders the overlay when the event carries shouldFlash: true", () => {
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();
  });

  it("does not render before the callback fires", () => {
    render(<AllClearOverlay />);
    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when the event carries shouldFlash: false", () => {
    // shouldFlash is computed main-process-side (flashEnabled, the master
    // enabled toggle, and the audio suppression chain) — see
    // AgentNotificationService.checkAllClear (#12185). The overlay trusts it
    // rather than recomputing suppression from its own settings mirror.
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(false);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when prefers-reduced-motion is set", () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("suppresses the overlay when data-reduce-animations is true", () => {
    document.body.setAttribute("data-reduce-animations", "true");
    try {
      render(<AllClearOverlay />);

      act(() => {
        fireAllClear(true);
      });

      expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
    } finally {
      document.body.removeAttribute("data-reduce-animations");
    }
  });

  it("suppresses the overlay when data-performance-mode is true", () => {
    document.body.setAttribute("data-performance-mode", "true");
    try {
      render(<AllClearOverlay />);

      act(() => {
        fireAllClear(true);
      });

      expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
    } finally {
      document.body.removeAttribute("data-performance-mode");
    }
  });

  it("suppresses the overlay in a project view that isn't on screen", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("hides via safety timeout when animationend never fires, never before the pulse ends", () => {
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    act(() => {
      vi.advanceTimersByTime(ALL_CLEAR_FLASH_DURATION);
    });
    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(ALL_CLEAR_FLASH_DURATION);
    });
    expect(document.body.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("carries no status hue: its colour comes from the stylesheet's neutral tint", () => {
    render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    const overlay = document.body.querySelector<HTMLElement>(OVERLAY_SELECTOR)!;
    expect(overlay.className).not.toMatch(/\b(bg|text|border)-(status|state|activity|accent)-/);
    expect(overlay.style.getPropertyValue("--all-clear-flash-duration")).toBe(
      `${ALL_CLEAR_FLASH_DURATION}ms`
    );
  });

  it("clears the safety timer on unmount", () => {
    const { unmount } = render(<AllClearOverlay />);

    act(() => {
      fireAllClear(true);
    });

    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });

  it("cleans up onAllAgentsClear listener on unmount", () => {
    const { unmount } = render(<AllClearOverlay />);
    unmount();
    expect(onAllAgentsClearCb).toBeNull();
  });
});

describe("all-clear flash stylesheet", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../index.css"), "utf-8");

  function zToken(name: string): number {
    const match = css.match(new RegExp(`--z-${name}:\\s*(\\d+);`));
    if (!match) throw new Error(`--z-${name} not found`);
    return Number(match[1]);
  }

  function ruleBody(selector: string, from = 0): string {
    const start = css.indexOf(`${selector} {`, from);
    if (start === -1) throw new Error(`${selector} rule not found`);
    return css.slice(start, css.indexOf("}", start));
  }

  it("sits above maximized content and below every modal, popover and toast layer", () => {
    const bell = zToken("visual-bell");
    expect(bell).toBeGreaterThan(zToken("maximized"));
    for (const layer of ["modal", "popover", "nested-dialog", "toast"]) {
      expect(bell).toBeLessThan(zToken(layer));
    }

    render(<AllClearOverlay />);
    act(() => {
      fireAllClear(true);
    });
    expect(document.body.querySelector(OVERLAY_SELECTOR)!.className).toContain(
      "z-[var(--z-visual-bell)]"
    );
  });

  it("rests at opacity 0, so a killed animation leaves nothing on screen", () => {
    expect(ruleBody(".animate-all-clear-flash")).toMatch(/\bopacity:\s*0;/);
  });

  it("is hidden, never snapped visible, under reduced motion", () => {
    const variants = [...css.matchAll(/@variant reduce-motion \{/g)].map((m) => m.index!);
    const hides = variants.some((at) => {
      const block = css.slice(at, css.indexOf("\n}\n", at));
      const rule = block.indexOf(".animate-all-clear-flash {");
      return rule !== -1 && /display:\s*none/.test(block.slice(rule, block.indexOf("}", rule)));
    });
    expect(hides).toBe(true);

    for (const at of variants) {
      const block = css.slice(at, css.indexOf("\n}\n", at));
      for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/opacity:\s*1\b/.test(rule[2]!)) {
          expect(rule[1]).not.toContain(".animate-all-clear-flash");
        }
      }
    }
  });
});
