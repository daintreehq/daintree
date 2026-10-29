// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { UI_EXIT_DURATION, UI_EXIT_EASING } from "../../../shared/config/uiMotion.js";
import {
  READ_SWITCH_SCREEN,
  SWITCH_SCREEN_HANDOFF_BUDGET_MS,
  prepareSwitchScreenHandoff,
} from "../switchScreenHandoff.js";

const SURFACE = { canvas: "rgb(20, 20, 19)", band: "oklch(0.2 0.01 250)", bandHeight: 47.6 };
const COVER_SELECTORS = ["body::after", "#startup-skeleton::after"];

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
  return screen;
}

/** Each selector's declarations, as a stylesheet's text gives them. */
function declarationsOf(css: string, selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors!.split(",").some((s) => s.trim() === selector))
    .map(([, , body]) => body)
    .join(" ");
}

function makeOutgoing(read: () => Promise<unknown> = () => Promise.resolve(SURFACE)) {
  return {
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    executeJavaScript: vi.fn((_code: string) => read()),
  };
}

function makeIncoming() {
  let next = 0;
  let drawFrame: () => void = () => {};
  const wc = {
    isDestroyed: vi.fn(() => false),
    insertCSS: vi.fn((_css: string, _options?: { cssOrigin?: string }) =>
      Promise.resolve(`css-${++next}`)
    ),
    removeInsertedCSS: vi.fn((_key: string) => Promise.resolve()),
    // The frame probe: held until the test draws the frame.
    executeJavaScript: vi.fn(
      (_code: string) => new Promise<unknown>((resolve) => (drawFrame = () => resolve(true)))
    ),
  };
  return { wc, drawFrame: () => drawFrame() };
}

function makeWin(opts: { visible?: boolean } = {}) {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => opts.visible ?? true,
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A prepared handoff, its cover on and its frame drawn. */
async function prepared(incoming = makeIncoming()) {
  const pending = prepareSwitchScreenHandoff(
    makeOutgoing() as never,
    incoming.wc as never,
    makeWin() as never
  );
  await flush();
  incoming.drawFrame();
  const handoff = await pending;
  if (!handoff) throw new Error("expected a handoff");
  return { handoff, incoming };
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

  it("hands nothing over from a screen that is hidden", () => {
    mountScreen({ shown: true }).style.visibility = "hidden";
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
    let ready = false;
    const pending = prepareSwitchScreenHandoff(
      outgoing as never,
      incoming.wc as never,
      makeWin() as never
    );
    void pending.then(() => (ready = true));
    await flush();

    expect(outgoing.executeJavaScript).toHaveBeenCalledWith(READ_SWITCH_SCREEN);
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(1);
    // Only an author-origin sheet can be taken off again in Electron 42.
    expect(incoming.wc.insertCSS.mock.calls[0]?.[1]?.cssOrigin ?? "author").toBe("author");
    const cover = incoming.wc.insertCSS.mock.calls[0]?.[0] ?? "";
    for (const selector of COVER_SELECTORS) {
      const rule = declarationsOf(cover, selector);
      expect(rule).toContain('content: "" !important');
      expect(rule).toContain("position: fixed !important");
      expect(rule).toContain("inset: 0 !important");
      expect(rule).toContain("pointer-events: none !important");
      expect(rule).toContain(`background-color: ${SURFACE.canvas} !important`);
      expect(rule).toContain(
        `linear-gradient(${SURFACE.band} 0 48px, ${SURFACE.canvas} 48px) !important`
      );
      expect(rule).toContain(
        `transition: opacity ${UI_EXIT_DURATION}ms ${UI_EXIT_EASING} !important`
      );
    }
    // Where the screen sat, under dialogs; and over the skeleton while it is up.
    expect(declarationsOf(cover, "body::after")).toContain(
      "z-index: calc(var(--z-toolbar) + 1) !important"
    );
    expect(ready).toBe(false);

    incoming.drawFrame();
    await flush();
    expect(ready).toBe(true);
    expect(await pending).not.toBeNull();
  });

  it("puts nothing on when the outgoing view has no screen up", async () => {
    const incoming = makeIncoming();
    const handoff = await prepareSwitchScreenHandoff(
      makeOutgoing(() => Promise.resolve(null)) as never,
      incoming.wc as never,
      makeWin() as never
    );
    expect(handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it("doesn't wait on an outgoing document that is still loading", async () => {
    const outgoing = makeOutgoing();
    outgoing.isLoadingMainFrame.mockReturnValue(true);
    const incoming = makeIncoming();
    const handoff = await prepareSwitchScreenHandoff(
      outgoing as never,
      incoming.wc as never,
      makeWin() as never
    );
    expect(handoff).toBeNull();
    expect(outgoing.executeJavaScript).not.toHaveBeenCalled();
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
      makeWin() as never
    );
    expect(handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it("gives up on an outgoing view that doesn't answer, so the swap isn't held", async () => {
    const incoming = makeIncoming();
    let settled = false;
    const handoff = prepareSwitchScreenHandoff(
      makeOutgoing(() => new Promise(() => {})) as never,
      incoming.wc as never,
      makeWin() as never
    );
    void handoff.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SWITCH_SCREEN_HANDOFF_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await handoff).toBeNull();
    expect(incoming.wc.insertCSS).not.toHaveBeenCalled();
  });

  it("spends one budget across the read and the frame, not one each", async () => {
    const incoming = makeIncoming();
    let settled = false;
    const handoff = prepareSwitchScreenHandoff(
      makeOutgoing(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(SURFACE), SWITCH_SCREEN_HANDOFF_BUDGET_MS - 10)
          )
      ) as never,
      incoming.wc as never,
      makeWin() as never
    );
    void handoff.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SWITCH_SCREEN_HANDOFF_BUDGET_MS - 1);
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    // The frame never comes: the cover is on, so the swap goes ahead and fades it.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await handoff).not.toBeNull();
  });

  it("doesn't wait for a frame in a window nobody can see", async () => {
    const incoming = makeIncoming();
    const handoff = await prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      makeWin({ visible: false }) as never
    );
    expect(handoff).not.toBeNull();
    expect(incoming.wc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("lands a cover that comes past the budget already faded, and takes both off", async () => {
    const incoming = makeIncoming();
    let land!: (key: string) => void;
    incoming.wc.insertCSS.mockImplementationOnce(
      () => new Promise<string>((resolve) => (land = resolve))
    );
    const handoff = prepareSwitchScreenHandoff(
      makeOutgoing() as never,
      incoming.wc as never,
      makeWin() as never
    );
    await vi.advanceTimersByTimeAsync(SWITCH_SCREEN_HANDOFF_BUDGET_MS);
    expect(await handoff).toBeNull();
    // Queued straight behind the cover, to the same renderer.
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(2);
    const fade = incoming.wc.insertCSS.mock.calls[1]?.[0] ?? "";
    for (const selector of COVER_SELECTORS) {
      expect(declarationsOf(fade, selector)).toContain("opacity: 0 !important");
    }

    land("late");
    await flush();
    expect(incoming.wc.removeInsertedCSS.mock.calls.map(([key]) => key).sort()).toEqual([
      "css-1",
      "late",
    ]);
  });

  it("fades the cover once released, then drops both stylesheets", async () => {
    const { handoff, incoming } = await prepared();

    handoff.release();
    handoff.release();
    await flush();
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(2);
    const fade = incoming.wc.insertCSS.mock.calls[1]?.[0] ?? "";
    for (const selector of COVER_SELECTORS) {
      expect(declarationsOf(fade, selector)).toContain("opacity: 0 !important");
    }

    await vi.advanceTimersByTimeAsync(UI_EXIT_DURATION - 1);
    expect(incoming.wc.removeInsertedCSS).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(incoming.wc.removeInsertedCSS.mock.calls.map(([key]) => key).sort()).toEqual([
      "css-1",
      "css-2",
    ]);
  });

  it("drops the cover at once without fading when the swap didn't happen", async () => {
    const { handoff, incoming } = await prepared();

    handoff.cancel();
    expect(incoming.wc.removeInsertedCSS).toHaveBeenCalledWith("css-1");
    handoff.release();
    await vi.advanceTimersByTimeAsync(UI_EXIT_DURATION);
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(1);
    expect(incoming.wc.removeInsertedCSS).toHaveBeenCalledTimes(1);
  });

  it("releases quietly into a view that has gone", async () => {
    const { handoff, incoming } = await prepared();

    incoming.wc.isDestroyed.mockReturnValue(true);
    expect(() => handoff.release()).not.toThrow();
    expect(incoming.wc.insertCSS).toHaveBeenCalledTimes(1);
  });
});
