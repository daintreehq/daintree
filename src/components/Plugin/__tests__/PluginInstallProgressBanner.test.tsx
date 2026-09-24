// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginInstallProgressBanner } from "../PluginInstallProgressBanner";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { PluginInstallProgressEvent } from "@shared/types/plugin";

const wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);

const SOURCE = "plugins.example.com/acme.dntr";

function progress(over: Partial<PluginInstallProgressEvent> = {}): PluginInstallProgressEvent {
  return { jobId: "job-1", phase: "extracting", cancellable: true, source: SOURCE, ...over };
}

type BannerProps = ComponentProps<typeof PluginInstallProgressBanner>;

function props(over: Partial<BannerProps> = {}): BannerProps {
  return {
    isInstalling: true,
    progress: progress(),
    source: SOURCE,
    cancelRequested: false,
    onCancel: vi.fn(),
    ...over,
  };
}

/** Push past the Doherty gate so the banner is allowed to render. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD + 10);
  });
}

/** The visible banner — not the screen-reader step announcer beside it. */
function banner(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[role='status'][aria-live='off']");
}

/** Text inside the visible banner; the announcer repeats the title. */
function inBanner(text: string): HTMLElement {
  return within(banner()!).getByText(text);
}

function announcer(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[role='status'][aria-live='polite']");
  if (!el) throw new Error("no step announcer");
  return el;
}

function cancelButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Cancel install" }) as HTMLButtonElement;
}

function stubMatchMedia() {
  // jsdom ships no matchMedia; InlineStatusBanner reads prefers-reduced-motion.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe("PluginInstallProgressBanner (#11302)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden for an install that finishes inside the Doherty threshold", () => {
    const { rerender } = render(<PluginInstallProgressBanner {...props({ progress: null })} />, {
      wrapper,
    });
    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 50);
    });
    expect(banner()).toBeNull();

    // A local .dntr installs in well under 400ms; flashing a banner for it is noise.
    rerender(<PluginInstallProgressBanner {...props({ isInstalling: false, progress: null })} />);
    settle();
    expect(banner()).toBeNull();
  });

  it("names the step once the wait is long enough to be worth reporting", () => {
    render(<PluginInstallProgressBanner {...props({ progress: null })} />, { wrapper });
    settle();
    // No event yet — it must not invent a phase the installer may skip.
    expect(inBanner("Installing the plugin")).toBeTruthy();
  });

  it("reports each phase in the user's terms", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "downloading" }) })} />,
      { wrapper }
    );
    settle();
    expect(inBanner("Downloading the plugin")).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "validating" }) })} />
    );
    expect(inBanner("Checking the plugin")).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner
        {...props({ progress: progress({ phase: "activating", cancellable: false }) })}
      />
    );
    expect(inBanner("Finishing the install")).toBeTruthy();
  });

  it("names what is being installed, and the entry in its place while unpacking", () => {
    const { rerender } = render(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "downloading" }) })} />,
      { wrapper }
    );
    settle();
    expect(banner()!.textContent).toContain("acme.dntr");

    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ entry: "dist/index.js" }) })} />
    );
    expect(banner()!.textContent).toContain("index.js");
    expect(banner()!.textContent).not.toContain("acme.dntr");

    // An entry left over from extraction must not trail into a later phase.
    rerender(
      <PluginInstallProgressBanner
        {...props({ progress: progress({ phase: "validating", entry: "dist/index.js" }) })}
      />
    );
    expect(banner()!.textContent).not.toContain("index.js");
    expect(banner()!.textContent).toContain("acme.dntr");
  });

  it("hands a long entry to the banner whole, so it can clip to the width it has", () => {
    const entry = `dist/${"deeply-nested/".repeat(6)}component.js`;
    render(<PluginInstallProgressBanner {...props({ progress: progress({ entry }) })} />, {
      wrapper,
    });
    settle();
    // Clipping is CSS's job at render time; nothing is thrown away up front, so
    // the full path stays recoverable from the hover title.
    expect(banner()!.querySelector(`[title="${entry}"]`)).not.toBeNull();
    expect(banner()!.textContent).not.toContain("…");
  });

  it("keeps the same shape through every state an install passes through", () => {
    const states: Partial<BannerProps>[] = [
      { progress: null },
      { progress: progress({ phase: "downloading" }) },
      { progress: progress({ entry: "dist/index.js" }) },
      { progress: progress({ phase: "validating" }) },
      { progress: progress({ phase: "activating", cancellable: false }) },
      { progress: progress({ entry: "assets/icon.png" }), cancelRequested: true },
    ];
    const { rerender } = render(<PluginInstallProgressBanner {...props(states[0])} />, {
      wrapper,
    });
    settle();
    const shape = () => {
      const root = banner()!;
      return {
        detailLines: root.querySelectorAll("p.font-mono").length,
        controls: root.querySelectorAll("[data-banner-controls] button").length,
        spinning: root.querySelectorAll(".animate-spin").length,
      };
    };
    const first = shape();
    expect(first).toEqual({ detailLines: 1, controls: 1, spinning: 1 });
    for (const state of states.slice(1)) {
      rerender(<PluginInstallProgressBanner {...props(state)} />);
      expect(shape()).toEqual(first);
    }
    // The five-second note joins the trailing cluster rather than adding a row.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "validating" }) })} />
    );
    expect(inBanner("Still working…")).toBeTruthy();
    expect(shape()).toEqual(first);
  });

  it("routes the cancel button to the caller", () => {
    const onCancel = vi.fn();
    render(<PluginInstallProgressBanner {...props({ onCancel })} />, { wrapper });
    settle();
    fireEvent.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("refuses cancel past the commit point, and says why", () => {
    const onCancel = vi.fn();
    render(
      <PluginInstallProgressBanner
        {...props({ progress: progress({ phase: "activating", cancellable: false }), onCancel })}
      />,
      { wrapper }
    );
    settle();
    // Past the swap there is nothing left to abort — a live button here would
    // promise a rollback the installer no longer offers.
    const button = cancelButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBeTruthy();
  });

  it("keeps keyboard focus on cancel when the install passes its commit point", () => {
    const { rerender } = render(<PluginInstallProgressBanner {...props()} />, { wrapper });
    settle();
    cancelButton().focus();
    expect(document.activeElement).toBe(cancelButton());

    rerender(
      <PluginInstallProgressBanner
        {...props({ progress: progress({ phase: "activating", cancellable: false }) })}
      />
    );
    // Chromium drops focus from a control the moment it becomes `:disabled` (jsdom
    // doesn't), so the unavailable state must never be the native one.
    expect(cancelButton().matches(":disabled")).toBe(false);
    expect(document.activeElement).toBe(cancelButton());
  });

  it("keeps cancel available before any progress arrives", () => {
    render(<PluginInstallProgressBanner {...props({ progress: null })} />, { wrapper });
    settle();
    expect(cancelButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("announces step changes but not the entry ticking over", () => {
    const { rerender } = render(<PluginInstallProgressBanner {...props({ progress: null })} />, {
      wrapper,
    });
    // Mounted before there is anything to say, so the first step is a change.
    expect(announcer().textContent).toBe("");
    settle();
    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ entry: "a/one.js" }) })} />
    );
    const unpacking = announcer().textContent;
    expect(unpacking).toBeTruthy();

    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ entry: "a/two.js" }) })} />
    );
    expect(announcer().textContent).toBe(unpacking);

    rerender(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "validating" }) })} />
    );
    expect(announcer().textContent).not.toBe(unpacking);
  });
});

describe("PluginInstallProgressBanner long waits and cancel state (#11302)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says it is still working once the wait passes five seconds", () => {
    render(
      <PluginInstallProgressBanner {...props({ progress: progress({ phase: "validating" }) })} />,
      { wrapper }
    );
    settle();
    expect(screen.queryByText("Still working…")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(inBanner("Still working…")).toBeTruthy();
  });

  it("drops the long-wait note when the install ends", () => {
    const { rerender } = render(<PluginInstallProgressBanner {...props()} />, { wrapper });
    settle();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(inBanner("Still working…")).toBeTruthy();

    rerender(<PluginInstallProgressBanner {...props({ isInstalling: false, progress: null })} />);
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("reports the cancel and stops accepting clicks once it has been requested", () => {
    const onCancel = vi.fn();
    render(<PluginInstallProgressBanner {...props({ cancelRequested: true, onCancel })} />, {
      wrapper,
    });
    settle();
    // The title must reflect the request immediately — main takes a moment to
    // unwind, and leaving "Unpacking the plugin" up reads as the click failing.
    expect(inBanner("Cancelling the install")).toBeTruthy();
    expect(cancelButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancelButton());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("suppresses the long-wait note while a cancel is unwinding", () => {
    render(<PluginInstallProgressBanner {...props({ cancelRequested: true })} />, { wrapper });
    settle();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // "Still working…" alongside "Cancelling the install" would contradict itself.
    expect(screen.queryByText("Still working…")).toBeNull();
  });
});
