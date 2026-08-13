// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  WindowControlsInsetProvider,
  useTitleBarSurface,
  useWindowControlsInset,
} from "../WindowControlsInset";
import { WINDOWS_CAPTION_WIDTH_PX } from "@shared/config/windowChrome";

/**
 * Issue #11766. `isWindows()`/`isMac()` read `navigator.platform`, so these
 * stub that rather than `process.platform` — the renderer never sees the Node
 * value, and a `process.platform` guard would make every case below vacuous on
 * Daintree's Ubuntu-only unit CI.
 */

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");

function setNavigatorPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", { value, configurable: true });
}

function Probe() {
  const inset = useWindowControlsInset();
  const surface = useTitleBarSurface();
  return (
    <div data-testid="probe" data-title-bar-surface={surface ? "true" : "false"} style={inset} />
  );
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(window.navigator, "platform", originalPlatform);
  } else {
    delete (window.navigator as unknown as Record<string, unknown>).platform;
  }
  vi.restoreAllMocks();
});

describe("WindowControlsInsetProvider", () => {
  it("reserves the shared caption width on Windows", () => {
    setNavigatorPlatform("Win32");
    render(
      <WindowControlsInsetProvider>
        <Probe />
      </WindowControlsInsetProvider>
    );
    // Constant, not env(titlebar-area-width): WCO variables never resolve in
    // the child WebContentsView the app renders in (electron/electron#34947).
    expect(screen.getByTestId("probe").style.paddingRight).toBe(`${WINDOWS_CAPTION_WIDTH_PX}px`);
    expect(screen.getByTestId("probe").style.paddingLeft).toBe("");
  });

  it("reserves space on the left for the macOS traffic lights instead", () => {
    setNavigatorPlatform("MacIntel");
    render(
      <WindowControlsInsetProvider>
        <Probe />
      </WindowControlsInsetProvider>
    );
    expect(screen.getByTestId("probe").style.paddingLeft).toBe("5rem");
    expect(screen.getByTestId("probe").style.paddingRight).toBe("");
  });

  it("reserves nothing on Linux, which has no overlaid window controls", () => {
    setNavigatorPlatform("Linux x86_64");
    render(
      <WindowControlsInsetProvider>
        <Probe />
      </WindowControlsInsetProvider>
    );
    const probe = screen.getByTestId("probe");
    expect(probe.style.paddingRight).toBe("");
    expect(probe.style.paddingLeft).toBe("");
  });

  it("reserves nothing outside a provider, where no OS chrome overlaps", () => {
    setNavigatorPlatform("Win32");
    render(<Probe />);
    expect(screen.getByTestId("probe").style.paddingRight).toBe("");
  });

  it("marks the surface as a title-bar host only when a reporter is supplied", () => {
    setNavigatorPlatform("Win32");
    const { rerender } = render(
      <WindowControlsInsetProvider>
        <Probe />
      </WindowControlsInsetProvider>
    );
    // A bare provider is still just an inset — the drag region and severity
    // reporting belong to the global banner host alone.
    expect(screen.getByTestId("probe").dataset.titleBarSurface).toBe("false");

    rerender(
      <WindowControlsInsetProvider onSeverityChange={vi.fn()}>
        <Probe />
      </WindowControlsInsetProvider>
    );
    expect(screen.getByTestId("probe").dataset.titleBarSurface).toBe("true");
  });
});
