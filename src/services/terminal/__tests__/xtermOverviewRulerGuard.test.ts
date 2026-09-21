import { describe, expect, it } from "vitest";
import { guardOverviewRulerRefresh } from "../xtermOverviewRulerGuard";

interface FakeDecoration {
  options: { overviewRulerOptions?: { color: string } };
}

/**
 * Stand-in for xterm 6.1's OverviewRulerRenderer. Its event subscriptions call
 * `this._queueRefresh(...)` with the same arguments the real ones pass, and the
 * queued frame calls `this._refreshDecorations()` — both through `this` at call
 * time, which is what lets an instance-level wrapper intercept them.
 */
function makeTerminal() {
  const frames: (() => void)[] = [];
  const decorations: FakeDecoration[] = [];
  const ruler = {
    draws: 0,
    border: "#111111",
    showTopBorder: false,
    renderer: true,
    _animationFrame: undefined as number | undefined,
    _shouldUpdateDimensions: true as boolean | undefined,
    _shouldUpdateAnchor: true as boolean | undefined,
    _decorationService: {
      get decorations() {
        return decorations.values();
      },
    },
    _themeService: {
      colors: {
        get overviewRulerBorder() {
          return { css: ruler.border };
        },
      },
    },
    _optionsService: {
      rawOptions: {
        scrollbar: {
          get overviewRuler() {
            return { showTopBorder: ruler.showTopBorder };
          },
        },
      },
    },
    _renderService: { hasRenderer: () => ruler.renderer },
    _refreshDecorations() {
      if (!this._renderService.hasRenderer()) return;
      this.draws++;
      this._shouldUpdateDimensions = false;
      this._shouldUpdateAnchor = false;
    },
    _queueRefresh(updateCanvasDimensions?: boolean, updateAnchor?: boolean) {
      this._shouldUpdateDimensions = updateCanvasDimensions || this._shouldUpdateDimensions;
      this._shouldUpdateAnchor = updateAnchor || this._shouldUpdateAnchor;
      if (this._animationFrame !== undefined) return;
      this._animationFrame = frames.push(() => {
        this._refreshDecorations();
        this._animationFrame = undefined;
      });
    },
  };
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  const events = {
    render: () => ruler._queueRefresh(),
    colors: () => ruler._queueRefresh(),
    dimensions: () => ruler._queueRefresh(true),
    decorationAdded: (decoration: FakeDecoration) => {
      decorations.push(decoration);
      ruler._queueRefresh(undefined, true);
    },
    decorationRemoved: (decoration: FakeDecoration) => {
      decorations.splice(decorations.indexOf(decoration), 1);
      ruler._queueRefresh(undefined, true);
    },
  };
  // The constructor queues the first draw before anyone can install a guard.
  ruler._queueRefresh(true);
  const terminal = { _core: { _overviewRulerRenderer: ruler } };
  return { terminal, ruler, events, flush, frames };
}

function guarded() {
  const t = makeTerminal();
  expect(guardOverviewRulerRefresh(t.terminal)).toBe(true);
  t.flush();
  expect(t.ruler.draws).toBe(1);
  return t;
}

const searchMatch = (): FakeDecoration => ({
  options: { overviewRulerOptions: { color: "#ff0000" } },
});

describe("guardOverviewRulerRefresh", () => {
  it("drops render-driven repaints while the ruler has nothing to draw", () => {
    const { ruler, events, flush, frames } = guarded();

    for (let i = 0; i < 5; i++) {
      events.render();
      flush();
    }

    expect(frames).toHaveLength(0);
    expect(ruler.draws).toBe(1);
  });

  it("repaints on every render while a ruler decoration is registered", () => {
    // Zones are placed against the buffer length, so they move as output grows.
    const { ruler, events, flush } = guarded();
    events.decorationAdded(searchMatch());
    flush();
    expect(ruler.draws).toBe(2);

    events.render();
    flush();
    events.render();
    flush();

    expect(ruler.draws).toBe(4);
  });

  it("repaints once to clear the last decoration, then goes quiet again", () => {
    const { ruler, events, flush } = guarded();
    const match = searchMatch();
    events.decorationAdded(match);
    flush();
    events.decorationRemoved(match);
    flush();
    expect(ruler.draws).toBe(3);

    events.render();
    flush();

    expect(ruler.draws).toBe(3);
  });

  it("keeps native behaviour while any decoration is registered", () => {
    const { ruler, events, flush } = guarded();
    events.decorationAdded({ options: {} });
    flush();
    events.render();
    flush();

    expect(ruler.draws).toBe(3);
  });

  it("passes resize, DPR and scrollbar-option refreshes through", () => {
    const { ruler, events, flush } = guarded();

    events.dimensions();
    flush();

    expect(ruler.draws).toBe(2);
  });

  it("repaints a theme change that alters the border", () => {
    const { ruler, events, flush } = guarded();

    ruler.border = "#222222";
    events.colors();
    flush();

    expect(ruler.draws).toBe(2);
  });

  it("repaints when a border option changes", () => {
    const { ruler, events, flush } = guarded();

    ruler.showTopBorder = true;
    events.render();
    flush();

    expect(ruler.draws).toBe(2);
  });

  it("does not skip until a draw has actually completed", () => {
    const t = makeTerminal();
    t.ruler.renderer = false;
    guardOverviewRulerRefresh(t.terminal);
    t.flush();
    expect(t.ruler.draws).toBe(0);

    t.ruler.renderer = true;
    t.events.render();
    t.flush();

    expect(t.ruler.draws).toBe(1);
  });

  it("is idempotent", () => {
    const { terminal, ruler, events, flush } = guarded();
    const wrapped = ruler._queueRefresh;

    expect(guardOverviewRulerRefresh(terminal)).toBe(true);
    expect(ruler._queueRefresh).toBe(wrapped);
    events.render();
    flush();
    expect(ruler.draws).toBe(1);
  });

  it("fails open when the ruler is missing or its internals drifted", () => {
    expect(guardOverviewRulerRefresh({ _core: {} })).toBe(false);
    expect(guardOverviewRulerRefresh({})).toBe(false);
    expect(
      guardOverviewRulerRefresh({ _core: { _overviewRulerRenderer: { _queueRefresh() {} } } })
    ).toBe(false);
  });

  it("keeps repainting when the theme service shape drifted", () => {
    const t = makeTerminal();
    (t.ruler as { _themeService: unknown })._themeService = {};
    guardOverviewRulerRefresh(t.terminal);
    t.flush();

    t.events.render();
    t.flush();

    expect(t.ruler.draws).toBe(2);
  });
});
