// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (isFullscreen: boolean) => void;

let listeners: Listener[] = [];
const onFullscreenChange = vi.fn((listener: Listener) => {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
});

function announce(isFullscreen: boolean) {
  act(() => {
    for (const listener of listeners) listener(isFullscreen);
  });
}

// Module state is the point of the hook, so every test gets a fresh copy.
async function loadHook() {
  vi.resetModules();
  const { useWindowFullscreen } = await import("../useWindowFullscreen");
  return function Probe({ id }: { id: string }) {
    return <span data-testid={id}>{useWindowFullscreen() ? "fullscreen" : "windowed"}</span>;
  };
}

beforeEach(() => {
  listeners = [];
  onFullscreenChange.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { window: { onFullscreenChange } },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("useWindowFullscreen", () => {
  it("follows the window in and out of fullscreen", async () => {
    const Probe = await loadHook();
    render(<Probe id="toolbar" />);
    expect(screen.getByTestId("toolbar").textContent).toBe("windowed");

    announce(true);
    expect(screen.getByTestId("toolbar").textContent).toBe("fullscreen");
    announce(false);
    expect(screen.getByTestId("toolbar").textContent).toBe("windowed");
  });

  it("tells a surface that mounts after the change, which main never tells again", async () => {
    const Probe = await loadHook();
    const { unmount } = render(<Probe id="toolbar" />);
    announce(true);
    // Every earlier subscriber gone: the state outlives them.
    unmount();

    render(<Probe id="late" />);
    expect(screen.getByTestId("late").textContent).toBe("fullscreen");
  });

  it("listens to main once however many surfaces read it", async () => {
    const Probe = await loadHook();
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>
    );
    expect(onFullscreenChange).toHaveBeenCalledTimes(1);
  });

  it("reads as windowed without a bridge, and starts listening once one is there", async () => {
    Reflect.deleteProperty(window, "electron");
    const Probe = await loadHook();
    const { unmount } = render(<Probe id="bare" />);
    expect(screen.getByTestId("bare").textContent).toBe("windowed");
    unmount();

    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { window: { onFullscreenChange } },
    });
    render(<Probe id="bridged" />);
    announce(true);
    expect(screen.getByTestId("bridged").textContent).toBe("fullscreen");
  });
});
