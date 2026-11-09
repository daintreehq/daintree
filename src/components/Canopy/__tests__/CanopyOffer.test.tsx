// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { TooltipProvider } from "@/components/ui/tooltip";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
const lifecycle = vi.hoisted(() => new Set<(phase: string) => void>());
const viewCached = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewCached: () => viewCached.current,
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycle.add(listener);
    return () => lifecycle.delete(listener);
  },
}));

import { notify } from "@/lib/notify";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopyOffer } from "../CanopyOffer";
import { CANOPY_TITLE } from "../canopyTerms";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

function snapshot(mode: CanopySnapshot["mode"], activated: boolean): CanopySnapshot {
  return {
    mode,
    activated,
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    lastError: null,
    failedRuns: [],
    glances: [],
  };
}

const canopy = {
  setMode: vi.fn(async (mode: CanopySnapshot["mode"]) => snapshot(mode, mode === "on")),
  setActive: vi.fn(),
  onSnapshotUpdated: vi.fn(() => () => {}),
};

/** Runs what the offer put off to the next frames, the way a browser paints. */
async function nextFrames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

const offer = () => document.querySelector<HTMLElement>('[data-testid="canopy-dialog"]');

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: { canopy },
    configurable: true,
    writable: true,
  });
  useCanopyStore.setState({ mode: "unset", isOpen: true, snapshot: null });
});

afterEach(() => {
  useCanopyStore.setState({ mode: "unset", isOpen: false, snapshot: null });
  canopy.setMode.mockClear();
  canopy.setActive.mockClear();
  canopy.onSnapshotUpdated.mockClear();
  vi.mocked(notify).mockClear();
  viewCached.current = false;
  lifecycle.clear();
});

describe("CanopyOffer, all of Canopy in a project window (#16581)", () => {
  it("waits in its own dialog until main says, then offers turning Canopy on in the same one", async () => {
    render(<CanopyOffer />);
    const dialog = offer()!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on Canopy" })).toBeNull();

    act(() => useCanopyStore.getState().applySnapshot(snapshot("unset", false)));

    expect(offer()).toBe(dialog);
    expect(screen.getByRole("button", { name: "Turn on Canopy" })).not.toBeNull();
    expect(dialog.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("covers the window, with nothing of the app behind it and no picture taken of it", async () => {
    const createObjectURL = vi.fn(() => "blob:still");
    const original = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    try {
      useCanopyStore.setState({ snapshot: snapshot("unset", false) });
      render(<CanopyOffer />);
      await nextFrames();

      const layer = offer()!;
      expect(layer.className).not.toMatch(/\bbackdrop-blur-|\bbg-scrim-/);
      expect(layer.firstElementChild?.className ?? "").not.toMatch(/\bmax-w-/);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(document.querySelector("img[src^='blob:']")).toBeNull();
    } finally {
      if (original) Object.defineProperty(URL, "createObjectURL", original);
      else Reflect.deleteProperty(URL, "createObjectURL");
    }
  });

  it("reads nothing and lists no host or agent: no inbox, search or host picker", async () => {
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    render(<CanopyOffer />);
    await nextFrames();

    expect(canopy.setActive).not.toHaveBeenCalled();
    expect(canopy.onSnapshotUpdated).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector("[data-canopy-standalone]")).toBeNull();
    expect(screen.queryByRole("button", { name: /host/i })).toBeNull();
  });

  it("turns Canopy on with main and takes its answer", async () => {
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    render(<CanopyOffer />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on Canopy" }));
    });

    expect(canopy.setMode).toHaveBeenCalledWith("on");
    expect(useCanopyStore.getState().mode).toBe("on");
    expect(useCanopyStore.getState().snapshot?.activated).toBe(true);
  });

  it("says so in place when turning it on failed, and stays open", async () => {
    canopy.setMode.mockRejectedValueOnce(new Error("no"));
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    render(<CanopyOffer />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on Canopy" }));
    });

    expect(screen.getByRole("status").textContent).toBe("Couldn't turn Canopy on. Try again.");
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });

  it("hides Canopy, putting the offer away and saying where it went", async () => {
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    render(<CanopyOffer />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide Canopy" }));
    });

    expect(canopy.setMode).toHaveBeenCalledWith("hidden");
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({ title: "Canopy hidden" });
  });

  it("closes on Escape and on its close button, as a dialog does", () => {
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    const view = render(<CanopyOffer />);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(useCanopyStore.getState().isOpen).toBe(false);

    view.unmount();
    useCanopyStore.setState({ isOpen: true });
    render(<CanopyOffer />);
    fireEvent.click(screen.getByRole("button", { name: `Close ${CANOPY_TITLE}` }));
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("goes when its project view is put in the background, or already was", () => {
    useCanopyStore.setState({ snapshot: snapshot("unset", false) });
    const view = render(<CanopyOffer />);
    expect(lifecycle.size).toBe(1);

    act(() => {
      for (const listener of lifecycle) listener("cached");
    });
    expect(useCanopyStore.getState().isOpen).toBe(false);
    view.unmount();

    viewCached.current = true;
    useCanopyStore.setState({ isOpen: true });
    render(<CanopyOffer />);
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("takes the keyboard off Turn on, and hands it back to what opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    useCanopyStore.setState({ isOpen: false });
    const view = render(<CanopyOffer />);
    act(() => useCanopyStore.setState({ isOpen: true }));
    await nextFrames();

    const loading = offer()!.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(document.activeElement).toBe(loading);

    act(() => useCanopyStore.getState().applySnapshot(snapshot("unset", false)));
    await nextFrames();
    expect(document.activeElement?.textContent).toBe("Every agent, read for you");

    // Put away as ModalHostLayer does: the gate unmounts it on close.
    act(() => useCanopyStore.getState().close());
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
