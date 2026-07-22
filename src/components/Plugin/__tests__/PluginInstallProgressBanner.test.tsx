// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginInstallProgressBanner } from "../PluginInstallProgressBanner";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { PluginInstallProgressEvent } from "@shared/types/plugin";

// The disabled Cancel carries an explanatory tooltip, so InlineStatusBanner
// needs a provider — the app supplies one at the App.tsx root.
const wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);

function progress(over: Partial<PluginInstallProgressEvent> = {}): PluginInstallProgressEvent {
  return { jobId: "job-1", phase: "extracting", cancellable: true, ...over };
}

/** Push past the Doherty gate so the banner is allowed to render. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD + 10);
  });
}

describe("PluginInstallProgressBanner (#11302)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom ships no matchMedia; InlineStatusBanner reads prefers-reduced-motion.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden for an install that finishes inside the Doherty threshold", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner
        isInstalling
        progress={null}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 50);
    });
    expect(screen.queryByRole("status")).toBeNull();

    // A local .dntr installs in well under 400ms; flashing a banner for it is noise.
    rerender(
      <PluginInstallProgressBanner
        isInstalling={false}
        progress={null}
        cancelRequested={false}
        onCancel={vi.fn()}
      />
    );
    settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the step once the wait is long enough to be worth reporting", () => {
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={null}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      {
        wrapper,
      }
    );
    settle();
    // No event yet — it must not invent a phase the installer may skip.
    expect(screen.getByText("Installing the plugin")).toBeTruthy();
  });

  it("reports each phase in the user's terms", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "downloading" })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    expect(screen.getByText("Downloading the plugin")).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "validating" })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("Checking the plugin")).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "activating", cancellable: false })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("Finishing the install")).toBeTruthy();
  });

  it("shows the archive entry while extracting, and only then", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ entry: "dist/index.js" })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    expect(screen.getByText("dist/index.js")).toBeTruthy();

    // An entry left over from extraction must not trail into a later phase.
    rerender(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "validating", entry: "dist/index.js" })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText("dist/index.js")).toBeNull();
  });

  it("elides a long entry path from the middle, keeping the filename readable", () => {
    const entry = `dist/${"deeply-nested/".repeat(6)}component.js`;
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ entry })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    expect(screen.queryByText(entry)).toBeNull();
    // The filename — the part that identifies the entry — survives truncation.
    expect(screen.getByText(/component\.js$/)).toBeTruthy();
  });

  it("routes the cancel button to the caller", () => {
    const onCancel = vi.fn();
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress()}
        cancelRequested={false}
        onCancel={onCancel}
      />,
      {
        wrapper,
      }
    );
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel install" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables cancel once the install has passed its commit point", () => {
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "activating", cancellable: false })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    // Past the swap there is nothing left to abort — a live button here would
    // promise a rollback the installer no longer offers.
    expect(screen.getByRole("button", { name: "Cancel install" })).toHaveProperty("disabled", true);
  });

  it("keeps cancel available before any progress arrives", () => {
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={null}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      {
        wrapper,
      }
    );
    settle();
    expect(screen.getByRole("button", { name: "Cancel install" })).toHaveProperty(
      "disabled",
      false
    );
  });
});

describe("PluginInstallProgressBanner long waits and cancel state (#11302)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says it is still working once the wait passes five seconds", () => {
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress({ phase: "validating" })}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    // Validating and activating carry no entry line, so without this the banner
    // would sit on one unchanging title and read as hung.
    expect(screen.queryByText("Still working…")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Still working…")).toBeTruthy();
  });

  it("drops the long-wait note when the install ends", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress()}
        cancelRequested={false}
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Still working…")).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner
        isInstalling={false}
        progress={null}
        cancelRequested={false}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("reports the cancel and stops accepting clicks once it has been requested", () => {
    const onCancel = vi.fn();
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress()}
        cancelRequested
        onCancel={onCancel}
      />,
      { wrapper }
    );
    settle();
    // The title must reflect the request immediately — main takes a moment to
    // unwind, and leaving "Unpacking the plugin" up reads as the click failing.
    expect(screen.getByText("Cancelling the install")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel install" })).toHaveProperty("disabled", true);
  });

  it("suppresses the long-wait note while a cancel is unwinding", () => {
    render(
      <PluginInstallProgressBanner
        isInstalling
        progress={progress()}
        cancelRequested
        onCancel={vi.fn()}
      />,
      { wrapper }
    );
    settle();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // "Still working…" alongside "Cancelling the install" would contradict itself.
    expect(screen.queryByText("Still working…")).toBeNull();
  });
});
