// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { UI_EXIT_DURATION } from "../../../shared/config/uiMotion.js";
import {
  READ_SWITCH_SCREEN,
  SWITCH_SCREEN_HANDOFF_BUDGET_MS,
  prepareSwitchScreenHandoff,
} from "../switchScreenHandoff.js";

const SURFACE = { canvas: "rgb(20, 20, 19)", band: "oklch(0.2 0.01 250)", bandHeight: 47.6 };

function readScreen(): unknown {
  return vm.runInNewContext(READ_SWITCH_SCREEN, {
    document,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLElement: window.HTMLElement,
  });
}

function mountScreen(opts: { shown: boolean }) {
  const screen = document.createElement("div");
  screen.setAttribute("data-testid", "host-switch-screen");
  screen.style.backgroundColor = "rgb(20, 20, 19)";
  if (!opts.shown) screen.style.opacity = "0";
  const band = document.createElement("div");
  band.style.backgroundColor = "rgb(30, 30, 28)";
  band.getBoundingClientRect = () => ({ height: 48 }) as DOMRect;
  screen.append(band, document.createElement("div"));
  document.body.append(screen);
}

function makeOutgoing(read: () => Promise<unknown> = () => Promise.resolve(SURFACE)) {
  return {
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn((_code: string) => read()),
  };
}

function makeIncoming() {
  let next = 0;
  let drawFrame: () => void = () => {};
  const wc = {
    isDestroyed: vi.fn(() => false),
    insertCSS: vi.fn((_css: string, _options?: unknown) => Promise.resolve(`css-${++next}`)),
    removeInsertedCSS: vi.fn((_key: string) => Promise.resolve()),
    // The frame probe: held until the test draws the frame.
    executeJavaScript: vi.fn(
      (_code: string) => new Promise<unknown>((resolve) => (drawFrame = () => resolve(true)))
    ),
  };
  return { wc, drawFrame: () => drawFrame() };
}

const win = {
  isDestroyed: () => false,
  isMinimized: () => false,
  isVisible: () => true,
  on: vi.fn(),
  removeListener: vi.fn(),
};

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("READ_SWITCH_SCREEN", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.performanceMode;
  });

  it("finds nothing to hand over when no switch screen is mounted", () => {
    expect(readScreen()).toBeNull();
  });

  it("hands nothing over from a screen still inside its loading gate", () => {
    mountScreen({ shown: false });
    expect(readScreen()).toBeNull();
  });

  it("hands nothing over in performance mode, which has no fade to run", () => {
    mountScreen({ shown: true });
    document.body.dataset.performanceMode = "true";
    expect(readScreen()).toBeNull();
  });

  it("reads the canvas and title band of a screen that is up", () => {
    mountScreen({ shown: true });
    expect(readScreen()).toEqual({
      canvas: "rgb(20, 20, 19)",
      band: "rgb(30, 30, 28)",
      bandHeight: 48,
    });
  });
});

describe("prepareSwitchScreenHandoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("covers the incoming view with the screen's surface and waits for a frame drawn with it", async () => {
    const outgoing = makeOutgoing();
    const incoming = makeIncoming();
    let prepared = false;
    const handoff = prepareSwitchScreenHandoff(outgoing as never, incoming.wc as never, win as never);
    void handoff.then(() => (prepared = true));
    await flush();

    expect(outgoing.executeJavaScript).toHaveBeenCalledWith(READ_SWITCH_SCREEN);
    const cover = incoming.wc.insertCSS.mock.calls[0]?.[0] ?? "";
    expect(incoming.wc.insertCSS.mock.calls[0]?.[1]).toEqual({ cssOrigin: "user" });
    expect(cover).toContain("linear-gradient(oklch(0.2 0.01 250) 0 48px, rgb(20, 20, 19) 48px)");
    expect(cover).toMatch(/body::after \{[^}]*z-index: calc\(var\(--z-toolbar\) \+ 1\)/);
    expect(cover).toMatch(/#startup-skeleton::after \{[^}]*pointer-events: none/);
    expect(prepared).toBe(false);

    incoming.drawFrame();
    await flush();
    expect(prepared).toBe(true);
    expect(await handoff).not.toBeNull();
  });

  it("puts nothing on when the outgoing view has no screen up", async () => {
    const incoming = makeIncoming();
    const handoff = await prepareSwitchScreenHandoff(
      makeOutgoing(() => Promise.resolve(null)) as never,
      incoming.wc as never,
      win as never
    );
    expect(handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it.each([
    ["a colour that would end its declaration", { ...SURFACE, canvas: "red; } body { x: y" }],
    ["a url instead of a colour", { ...SURFACE, band: "url(x)" }],
    ["a height that isn't a number", { ...SURFACE, bandHeight: "48px" }],
  ])("puts nothing on for %s", async (_label, surface) => {
    const incoming = makeIncoming();
    const handoff = await prepareSwitchScreenHandoff(
      makeOutgoing(() => Promise.resolve(surface)) as never,
      incoming.wc as never,
      win as never
    );
    expect(handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it("gives up on an outgoing view that doesn't answer, so the swap isn't held", async () => {
    const incoming = makeIncoming();
    const handoff = prepareSwitchScreenHandoff(
      makeOutgoing(() => new Promise(() => {})) as never,
      incoming.wc as never,
      win as never
    );
    await vi.advanceTimersByTimeAsync(SWITCH_SCREEN_HANDOFF_BUDGET_MS);
    expect(await handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it("takes a cover that lands past the budget straight off again", async () => {
    const incoming = makeIncoming();
    let land!: (key: string) => void;
    incoming.wc.insertCSS.mockImplementationOnce(
      () => new Promise<string>((resolve) => (land = resolve))
    );
    const handoff = prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      win as never
    );
    await vi.advanceTimersByTimeAsync(SWITCH_SCREEN_HANDOFF_BUDGET_MS);
    expect(await handoff).toBeNull();

    land("late");
    await flush();
    expect(incoming.wc.removeInsertedCSS).toHaveBeenCalledWith("late");
  });

  it("fades the cover once released, then drops both stylesheets", async () => {
    const incoming = makeIncoming();
    const pending = prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      win as never
    );
    await flush();
    incoming.drawFrame();
    const handoff = await pending;

    handoff!.release();
    handoff!.release();
    await flush();
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(2);
    expect(incoming.wc.insertCSS.mock.calls[1]?.[0]).toMatch(/opacity: 0/);
    expect(incoming.wc.removeInsertedCSS).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UI_EXIT_DURATION);
    expect(incoming.wc.removeInsertedCSS.mock.calls.map(([key]) => key).sort()).toEqual([
      "css-1",
      "css-2",
    ]);
  });

  it("drops the cover at once without fading when the swap didn't happen", async () => {
    const incoming = makeIncoming();
    const pending = prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      win as never
    );
    await flush();
    incoming.drawFrame();
    const handoff = await pending;

    handoff!.cancel();
    handoff!.release();
    await vi.advanceTimersByTimeAsync(UI_EXIT_DURATION);
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(1);
    expect(incoming.wc.removeInsertedCSS).toHaveBeenCalledWith("css-1");
  });

  it("releases quietly into a view that has gone", async () => {
    const incoming = makeIncoming();
    const pending = prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      win as never
    );
    await flush();
    incoming.drawFrame();
    const handoff = await pending;

    incoming.wc.isDestroyed.mockReturnValue(true);
    incoming.wc.insertCSS.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    expect(() => handoff!.release()).not.toThrow();
  });
});
