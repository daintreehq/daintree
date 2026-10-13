import { describe, it, expect, vi } from "vitest";
import type { WebContents } from "electron";
import { onMainFrameNavigationStart, watchMainFrameDocument } from "../mainFrameNavigation.js";

type Listener = (...args: unknown[]) => void;

// Emits what Electron 42 emits: nothing at the end of an uncommitted navigation,
// did-navigate for a committed page, did-fail-provisional-load only for a
// committed error page, and did-stop-loading once loading is over either way.
function fakeWebContents() {
  const handlers = new Map<string, Listener[]>();
  const wc = {
    on: vi.fn((event: string, listener: Listener) => {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
    }),
  } as unknown as WebContents;
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of handlers.get(event) ?? []) listener(...args);
  };
  return {
    wc,
    start: (isMainFrame = true, isSameDocument = false) =>
      emit("did-start-navigation", { isMainFrame, isSameDocument }),
    commit: () => emit("did-navigate", {}, "app://daintree/index.html", 200, "OK"),
    commitErrorPage: (isMainFrame = true) =>
      emit(
        "did-fail-provisional-load",
        {},
        -102,
        "ERR_CONNECTION_REFUSED",
        "http://x/",
        isMainFrame
      ),
    stop: () => emit("did-stop-loading"),
    crash: () => emit("render-process-gone", {}, { reason: "crashed", exitCode: 139 }),
  };
}

describe("onMainFrameNavigationStart", () => {
  it("fires for a cross-document main-frame navigation only", () => {
    const nav = fakeWebContents();
    const listener = vi.fn();
    onMainFrameNavigationStart(nav.wc, listener);
    nav.start(false, false);
    nav.start(true, true);
    expect(listener).not.toHaveBeenCalled();
    nav.start(true, false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("watchMainFrameDocument", () => {
  function watch() {
    const nav = fakeWebContents();
    const callbacks = { onLeaving: vi.fn(), onReplaced: vi.fn(), onSettled: vi.fn() };
    watchMainFrameDocument(nav.wc, callbacks);
    return { ...nav, ...callbacks };
  }

  it("ignores subframe and same-document navigations", () => {
    const w = watch();
    w.start(false, false);
    w.start(true, true);
    w.commitErrorPage(false);
    expect(w.onLeaving).not.toHaveBeenCalled();
    expect(w.onReplaced).not.toHaveBeenCalled();
  });

  it("reports a cancelled navigation only as leaving, then settled", () => {
    const w = watch();
    w.start();
    w.stop();
    expect(w.onLeaving).toHaveBeenCalledTimes(1);
    expect(w.onReplaced).not.toHaveBeenCalled();
    expect(w.onSettled).toHaveBeenCalledTimes(1);
  });

  it("reports a committed page before loading settles", () => {
    const w = watch();
    w.start();
    w.commit();
    w.stop();
    expect(w.onReplaced).toHaveBeenCalledTimes(1);
    expect(w.onReplaced.mock.invocationCallOrder[0]).toBeLessThan(
      w.onSettled.mock.invocationCallOrder[0]
    );
  });

  it("reports a committed error page as a replacement", () => {
    const w = watch();
    w.start();
    w.commitErrorPage();
    expect(w.onReplaced).toHaveBeenCalledTimes(1);
  });

  it("reports a dead renderer as a replacement", () => {
    const w = watch();
    w.crash();
    expect(w.onReplaced).toHaveBeenCalledTimes(1);
  });
});
