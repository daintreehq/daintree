// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The client's own platform: it names a local file manager, and only a Windows
// PC can reach a WSL distro.
const client = vi.hoisted(() => ({ mac: true, windows: false }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => client.mac,
  isWindows: () => client.windows,
}));

import { Copy } from "lucide-react";
import { FolderOpen } from "@/components/icons";
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

const realAnnounce = useAnnouncerStore.getState().announce;
const politeMessage = () => useAnnouncerStore.getState().polite?.msg ?? null;
const politeId = () => useAnnouncerStore.getState().polite?.id ?? 0;

beforeEach(() => {
  client.mac = true;
  client.windows = false;
  _resetCopyFlashForTests();
  useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1, announce: realAnnounce });
});

afterEach(() => {
  // Unmounted before the host resets, so no subscriber hears it.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetCopyFlashForTests();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("useRevealCopy", () => {
  const summary = (copy: ReturnType<typeof revealCopy>) => ({
    label: copy.label,
    icon: copy.icon,
    copiedAnnouncement: copy.copiedAnnouncement,
  });

  it.each([
    ["a Mac", true, false, "Reveal in Finder"],
    ["a Windows PC", false, true, "Show in Explorer"],
    ["a Linux PC", false, false, "Show in folder"],
  ])("reveals in %s's own file manager, claiming no copy", (_name, mac, windows, label) => {
    client.mac = mac;
    client.windows = windows;
    const { result } = renderHook(() => useRevealCopy());
    expect(summary(result.current)).toEqual({ label, icon: FolderOpen, copiedAnnouncement: null });
  });

  it("copies for an ssh host from a Mac, before main has named the connection", () => {
    // Only a Windows PC reaches a WSL distro, so nowhere else is an unknown
    // connection anything but ssh.
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    const { result } = renderHook(() => useRevealCopy());
    expect(summary(result.current)).toEqual({
      label: "Copy host path",
      icon: Copy,
      copiedAnnouncement: "Host path copied",
    });
  });

  it("treats a Windows PC's remote window as the WSL distro it must be, before main says so", () => {
    // Daintree for Windows reaches only WSL distros, which main reveals in
    // Explorer: claiming a copy there would confirm one that never happened.
    client.mac = false;
    client.windows = true;
    window.__DAINTREE_HOST_ID__ = { id: "wsl-ubuntu" };
    const { result } = renderHook(() => useRevealCopy());
    expect(summary(result.current)).toEqual({
      label: "Show in Explorer",
      icon: FolderOpen,
      copiedAnnouncement: null,
    });

    act(() => setHostPlatformInfo({ connection: { kind: "wsl", distro: "Ubuntu" } }));

    expect(result.current.label).toBe("Show in Explorer");
  });

  it("follows the connection main reports once it lands", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    const { result } = renderHook(() => useRevealCopy());
    expect(result.current.copiedAnnouncement).toBe("Host path copied");

    act(() => setHostPlatformInfo({ connection: { kind: "wsl", distro: "Ubuntu" } }));

    expect(summary(result.current)).toEqual({
      label: "Show in Explorer",
      icon: FolderOpen,
      copiedAnnouncement: null,
    });
  });
});

describe("runTransientReveal", () => {
  it("announces once and flashes where it was asked for, after the copy succeeded", async () => {
    enterRemoteWindow();
    // Where the gesture happened: the chosen row holds focus only until the
    // menu closes, so the flash has to be anchored before the copy settles.
    const row = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(row, elsewhere);
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 120, 160, 24));
    vi.spyOn(elsewhere, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 600, 80, 24));
    row.focus();
    const copy = deferred();

    runTransientReveal(revealCopy(), () => copy.promise);
    elsewhere.focus();
    row.remove();
    // Nothing is claimed while main is still writing.
    expect(politeMessage()).toBeNull();
    expect(getCopyFlash()).toBeNull();

    await act(async () => copy.resolve(true));

    expect(politeMessage()).toBe("Host path copied");
    expect(politeId()).toBe(1);
    expect(getCopyFlash()?.origin).toEqual({
      kind: "rect",
      left: 40,
      top: 120,
      right: 200,
      bottom: 144,
    });
    elsewhere.remove();
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
  const shows = (name: string) =>
    glyph("Copy host path")?.classList.contains(`lucide-${name}`) ?? false;

  it("wears the copy glyph in a remote window and swaps to a check for the dwell once the copy landed", async () => {
    enterRemoteWindow();
    vi.useFakeTimers();
    const copy = deferred();
    render(renderButton(() => copy.promise));
    expect(shows("copy")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    expect(shows("check")).toBe(false);
    await act(async () => copy.resolve(true));

    // The name stays put while the glyph confirms; the announcer speaks once.
    expect(shows("check")).toBe(true);
    expect(politeMessage()).toBe("Host path copied");
    expect(politeId()).toBe(1);
    expect(getCopyFlash()).toBeNull();

    act(() => void vi.advanceTimersByTime(1999));
    expect(shows("check")).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(shows("copy")).toBe(true);
  });

  it("leaves a failed copy to the pane's banner", async () => {
    enterRemoteWindow();
    const onReveal = vi.fn(() => Promise.resolve(false));
    render(renderButton(onReveal));

    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    await act(async () => {});

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(shows("check")).toBe(false);
    expect(politeMessage()).toBeNull();
  });

  it("doesn't carry the check to another file", async () => {
    enterRemoteWindow();
    const { rerender } = render(renderButton(() => Promise.resolve(true)));
    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    await act(async () => {});
    expect(shows("check")).toBe(true);

    rerender(renderButton(() => Promise.resolve(true), "/home/greg/repo/README.md"));

    expect(shows("copy")).toBe(true);
  });

  it("doesn't confirm a new file with a copy of the old one that lands late", async () => {
    enterRemoteWindow();
    const copy = deferred();
    const { rerender } = render(renderButton(() => copy.promise));
    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));

    rerender(renderButton(() => Promise.resolve(true), "/home/greg/repo/README.md"));
    await act(async () => copy.resolve(true));

    // The copy of the first file did happen, so it is still announced.
    expect(shows("copy")).toBe(true);
    expect(politeMessage()).toBe("Host path copied");
  });

  it("confirms where it was asked for when the control is gone before the copy lands", async () => {
    // A toolbar narrowed mid-copy folds the button into its menu.
    enterRemoteWindow();
    const copy = deferred();
    const { unmount } = render(renderButton(() => copy.promise));
    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));

    unmount();
    await act(async () => copy.resolve(true));

    expect(politeMessage()).toBe("Host path copied");
    expect(politeId()).toBe(1);
    expect(getCopyFlash()).not.toBeNull();
  });

  it("announces once even when the announcement itself takes the control down", async () => {
    // Whatever speaks first must be the only thing that speaks: a second owner
    // that sees the control gone would otherwise confirm the same copy again.
    enterRemoteWindow();
    const { unmount } = render(renderButton(() => Promise.resolve(true)));
    let announced = 0;
    useAnnouncerStore.setState({
      announce: (msg, priority) => {
        announced += 1;
        realAnnounce(msg, priority);
        if (announced === 1) unmount();
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy host path" }));
    await act(async () => {});

    expect(announced).toBe(1);
    expect(politeMessage()).toBe("Host path copied");
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
    expect(getCopyFlash()).toBeNull();
  });
});
