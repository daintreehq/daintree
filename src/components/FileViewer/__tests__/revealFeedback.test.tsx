// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
  isWindows: () => false,
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { _resetCopyFlashForTests, getCopyFlash } from "@/lib/copyFlash";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { FileViewerToolbar } from "../FileViewerToolbar";
import { revealCopy, useRevealCopy } from "../revealCopy";
import { RevealActionButton, runTransientReveal } from "../revealFeedback";

const PATH = "/home/greg/repo/src/index.ts";

function enterRemoteWindow(connection: "ssh" | "wsl" = "ssh") {
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  setHostPlatformInfo({
    platform: "linux",
    connection:
      connection === "ssh"
        ? { kind: "ssh", target: "greg@studio-01" }
        : { kind: "wsl", distro: "Ubuntu" },
  });
}

/** Resolves when the test says so, so a check can't be asserted before the copy settled. */
function deferred() {
  let resolve: (ok: boolean) => void = () => {};
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const politeMessage = () => useAnnouncerStore.getState().polite?.msg ?? null;

beforeEach(() => {
  _resetCopyFlashForTests();
  useAnnouncerStore.setState({ polite: null, assertive: null });
});

afterEach(() => {
  // Unmounted before the host resets, so no subscriber hears it.
  cleanup();
  vi.useRealTimers();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("useRevealCopy", () => {
  it("drops the copy once main reports the window is a WSL distro", () => {
    // The host id is known from the first render, the connection kind only
    // once main reports it: a reveal still wearing "Copy host path" after that
    // would confirm a copy main never made.
    window.__DAINTREE_HOST_ID__ = { id: "wsl-ubuntu" };
    const { result } = renderHook(() => useRevealCopy());
    expect(result.current.label).toBe("Copy host path");
    expect(result.current.copiedAnnouncement).toBe("Host path copied");

    act(() => setHostPlatformInfo({ connection: { kind: "wsl", distro: "Ubuntu" } }));

    expect(result.current.label).toBe("Show in Explorer");
    expect(result.current.copiedAnnouncement).toBeNull();
  });

  it("agrees with revealCopy", () => {
    const { result } = renderHook(() => useRevealCopy());
    expect(result.current).toEqual(revealCopy());
  });
});

describe("runTransientReveal", () => {
  it("announces and flashes a remote copy once it succeeded", async () => {
    enterRemoteWindow();
    const copy = deferred();

    runTransientReveal(revealCopy(), () => copy.promise);
    // Nothing is claimed while main is still writing.
    expect(politeMessage()).toBeNull();
    expect(getCopyFlash()).toBeNull();

    await act(async () => copy.resolve(true));

    expect(politeMessage()).toBe("Host path copied");
    expect(getCopyFlash()).not.toBeNull();
  });

  it("claims nothing when the copy failed", async () => {
    // The surface's own banner or toast reports the failure.
    enterRemoteWindow();

    runTransientReveal(revealCopy(), () => Promise.resolve(false));
    await act(async () => {});

    expect(politeMessage()).toBeNull();
    expect(getCopyFlash()).toBeNull();
  });

  it.each([
    ["a local window", () => {}],
    ["a WSL window", () => enterRemoteWindow("wsl")],
  ])("adds nothing to a real reveal in %s", async (_name, enter) => {
    enter();
    const run = vi.fn(() => Promise.resolve(true));

    runTransientReveal(revealCopy(), run);
    await act(async () => {});

    expect(run).toHaveBeenCalledTimes(1);
    expect(politeMessage()).toBeNull();
    expect(getCopyFlash()).toBeNull();
  });
});

describe.each([
  [
    "FileViewerToolbar.RevealButton",
    (onReveal: () => Promise<boolean>, path = PATH) => (
      <FileViewerToolbar.RevealButton reveal={revealCopy()} path={path} onReveal={onReveal} />
    ),
  ],
  [
    "RevealActionButton",
    (onReveal: () => Promise<boolean>, path = PATH) => (
      <RevealActionButton reveal={revealCopy()} path={path} onReveal={onReveal} variant="subtle" />
    ),
  ],
])("%s", (_name, renderButton) => {
  const glyph = (name: string) => screen.getByRole("button", { name }).querySelector("svg");

  it("wears the copy glyph in a remote window and swaps to a check once the copy landed", async () => {
    enterRemoteWindow();
    vi.useFakeTimers();
    const copy = deferred();
    render(renderButton(() => copy.promise));
    expect(glyph("Copy host path")?.classList.contains("lucide-copy")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    expect(glyph("Copy host path")?.classList.contains("lucide-check")).toBe(false);
    await act(async () => copy.resolve(true));

    // The name stays put while the glyph confirms; the announcer speaks.
    expect(glyph("Copy host path")?.classList.contains("lucide-check")).toBe(true);
    expect(politeMessage()).toBe("Host path copied");

    act(() => void vi.advanceTimersByTime(2000));
    expect(glyph("Copy host path")?.classList.contains("lucide-copy")).toBe(true);
  });

  it("leaves a failed copy to the pane's banner", async () => {
    enterRemoteWindow();
    const onReveal = vi.fn(() => Promise.resolve(false));
    render(renderButton(onReveal));

    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    await act(async () => {});

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(glyph("Copy host path")?.classList.contains("lucide-check")).toBe(false);
    expect(politeMessage()).toBeNull();
  });

  it("doesn't carry the check to another file", async () => {
    enterRemoteWindow();
    const { rerender } = render(renderButton(() => Promise.resolve(true)));
    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    await act(async () => {});
    expect(glyph("Copy host path")?.classList.contains("lucide-check")).toBe(true);

    rerender(renderButton(() => Promise.resolve(true), "/home/greg/repo/README.md"));

    expect(glyph("Copy host path")?.classList.contains("lucide-copy")).toBe(true);
  });

  it("keeps a local reveal's folder glyph and adds no feedback", async () => {
    const onReveal = vi.fn(() => Promise.resolve(true));
    render(renderButton(onReveal));
    expect(glyph("Reveal in Finder")?.classList.contains("lucide-folder-open")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    await act(async () => {});

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(glyph("Reveal in Finder")?.classList.contains("lucide-folder-open")).toBe(true);
    expect(politeMessage()).toBeNull();
  });
});
