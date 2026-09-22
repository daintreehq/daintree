import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  isXtermRenderSuspended,
  resumeXtermRender,
  suspendXtermRender,
} from "../xtermRenderSuspension";

type Entry = Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">;

/**
 * Stand-in for xterm 6.1's RenderService: `_handleIntersectionChange` is the
 * only writer of `_isPaused`, and its IntersectionObserver calls it through
 * `this` — `deliver` models exactly that call so a wrapper installed on the
 * instance intercepts it the way the real observer's does.
 */
function makeTerminal(initiallyPaused = false) {
  const renderService = {
    _isPaused: initiallyPaused,
    handled: [] as Entry[],
    _handleIntersectionChange(entry: Entry) {
      this.handled.push({
        isIntersecting: entry.isIntersecting,
        intersectionRatio: entry.intersectionRatio,
      });
      this._isPaused = !entry.isIntersecting;
    },
  };
  const refresh = vi.fn();
  const terminal = { _core: { _renderService: renderService }, rows: 24, refresh };
  const deliver = (isIntersecting: boolean) =>
    renderService._handleIntersectionChange({
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    });
  return { terminal: terminal as unknown as Terminal, renderService, refresh, deliver };
}

describe("xtermRenderSuspension", () => {
  it("pauses the renderer through xterm's own transition", () => {
    const { terminal, renderService } = makeTerminal();

    expect(suspendXtermRender(terminal)).toBe(true);

    expect(renderService._isPaused).toBe(true);
    expect(renderService.handled).toEqual([{ isIntersecting: false, intersectionRatio: 0 }]);
    expect(isXtermRenderSuspended(terminal)).toBe(true);
  });

  it("keeps the pause when the observer reports the pane visible while suspended", () => {
    // A cached view's panes still intersect the viewport as far as Chromium
    // knows, and a terminal opened while cached gets its first delivery after
    // the suspend — neither may restart painting.
    const { terminal, renderService, deliver } = makeTerminal();
    suspendXtermRender(terminal);

    deliver(true);

    expect(renderService._isPaused).toBe(true);
  });

  it("resumes with a full repaint when the pane is on screen", () => {
    const { terminal, renderService, refresh } = makeTerminal();
    suspendXtermRender(terminal);

    resumeXtermRender(terminal);

    expect(renderService._isPaused).toBe(false);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(isXtermRenderSuspended(terminal)).toBe(false);
  });

  it("resumes into the last real observation, so a pane that left the viewport stays paused", () => {
    const { terminal, renderService, refresh, deliver } = makeTerminal();
    suspendXtermRender(terminal);
    deliver(false);

    resumeXtermRender(terminal);

    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never unpauses a pane xterm's own observer paused before the suspend", () => {
    const { terminal, renderService, refresh } = makeTerminal(true);
    suspendXtermRender(terminal);

    resumeXtermRender(terminal);

    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("treats resume without a suspend as a no-op", () => {
    const { terminal, renderService, refresh } = makeTerminal(true);

    resumeXtermRender(terminal);

    expect(renderService._isPaused).toBe(true);
    expect(renderService.handled).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("passes observations straight through once resumed", () => {
    const { terminal, renderService, deliver } = makeTerminal();
    suspendXtermRender(terminal);
    resumeXtermRender(terminal);

    deliver(false);
    expect(renderService._isPaused).toBe(true);
    deliver(true);
    expect(renderService._isPaused).toBe(false);
  });

  it("is idempotent across repeated suspends", () => {
    const { terminal, renderService } = makeTerminal();
    suspendXtermRender(terminal);
    suspendXtermRender(terminal);

    expect(renderService.handled).toHaveLength(1);
  });

  it("fails closed when xterm's internals are missing", () => {
    const bare = { rows: 24, refresh: vi.fn() } as unknown as Terminal;
    const noHandler = {
      _core: { _renderService: { _isPaused: false } },
      rows: 24,
      refresh: vi.fn(),
    } as unknown as Terminal;

    expect(suspendXtermRender(bare)).toBe(false);
    expect(suspendXtermRender(noHandler)).toBe(false);
    expect(() => resumeXtermRender(bare)).not.toThrow();
    expect(isXtermRenderSuspended(noHandler)).toBe(false);
  });
});
