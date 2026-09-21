import type { Terminal } from "@xterm/xterm";

/**
 * Stop xterm's overview ruler repainting after every render when it has
 * nothing to draw (#12584).
 *
 * Setting `scrollbar.width` (search matches in the scrollbar) builds an
 * `OverviewRulerRenderer`, which answers every `onRenderedViewportChange` by
 * requesting an animation frame that clears and redraws its canvas — whether
 * or not a single decoration asks to be drawn. The request is made inside the
 * render's own frame, so it lands in the next one: every terminal update
 * becomes two committed, presented frames instead of one.
 *
 * With no decorations the picture is only a themed border, which a
 * content render cannot change. So an argument-less refresh — the render path,
 * and also the theme path — is dropped when the last completed draw was
 * empty, nothing is pending, there is still nothing to draw, and the border
 * would come out identical. Every other trigger passes through untouched:
 * decoration add/remove, resize, DPR and scrollbar options all call with a
 * flag, and a theme change that alters the border fails the comparison.
 *
 * Pinned to @xterm/xterm 6.1.0-beta.304, where the renderer's subscriptions
 * reach `_queueRefresh` and its frame callback reaches `_refreshDecorations`
 * through `this` at call time, so instance properties shadow both. Every
 * access fails open: on API drift the ruler keeps repainting, today's
 * behaviour.
 */

interface OverviewRulerLike {
  _queueRefresh?: (updateCanvasDimensions?: boolean, updateAnchor?: boolean) => void;
  _refreshDecorations?: () => void;
  _animationFrame?: number;
  _shouldUpdateDimensions?: boolean;
  _shouldUpdateAnchor?: boolean;
  _decorationService?: { decorations?: Iterable<unknown> };
  _themeService?: { colors?: { overviewRulerBorder?: { css?: string } } };
  _optionsService?: {
    rawOptions?: {
      scrollbar?: { overviewRuler?: { showTopBorder?: boolean; showBottomBorder?: boolean } };
    };
  };
  _renderService?: { hasRenderer?: () => boolean };
}

const guarded = new WeakSet<OverviewRulerLike>();

function getRuler(terminal: Terminal): OverviewRulerLike | undefined {
  try {
    return (terminal as Terminal & { _core?: { _overviewRulerRenderer?: OverviewRulerLike } })
      ._core?._overviewRulerRenderer;
  } catch {
    return undefined;
  }
}

// Any decoration at all counts: only search matches are registered today, and
// they all draw on the ruler. A presence check keeps the render path O(1).
function hasDecorations(ruler: OverviewRulerLike): boolean {
  const decorations = ruler._decorationService?.decorations;
  if (!decorations) return true;
  return decorations[Symbol.iterator]().next().done !== true;
}

// Everything an empty ruler's picture depends on besides canvas geometry,
// which only changes through the flagged dimension path.
function emptyPictureKey(ruler: OverviewRulerLike): string | undefined {
  const border = ruler._themeService?.colors?.overviewRulerBorder?.css;
  if (typeof border !== "string") return undefined;
  const overviewRuler = ruler._optionsService?.rawOptions?.scrollbar?.overviewRuler;
  return `${border}|${overviewRuler?.showTopBorder === true}|${overviewRuler?.showBottomBorder === true}`;
}

/**
 * Install the guard on the terminal's overview ruler. Idempotent; returns
 * whether the ruler is guarded. Call after `terminal.open()`.
 */
export function guardOverviewRulerRefresh(terminal: Terminal): boolean {
  try {
    const ruler = getRuler(terminal);
    if (!ruler) return false;
    if (guarded.has(ruler)) return true;
    const queueRefresh = ruler._queueRefresh;
    const refreshDecorations = ruler._refreshDecorations;
    if (typeof queueRefresh !== "function" || typeof refreshDecorations !== "function") {
      return false;
    }

    // Key of the last draw that completed with nothing to draw; undefined
    // whenever the canvas may show anything else.
    let drawnEmptyKey: string | undefined;

    ruler._refreshDecorations = function (this: OverviewRulerLike) {
      const willDraw = ruler._renderService?.hasRenderer?.() === true;
      const key = willDraw && !hasDecorations(ruler) ? emptyPictureKey(ruler) : undefined;
      drawnEmptyKey = undefined;
      refreshDecorations.call(this);
      drawnEmptyKey = key;
    };

    ruler._queueRefresh = function (
      this: OverviewRulerLike,
      updateCanvasDimensions?: boolean,
      updateAnchor?: boolean
    ) {
      if (
        !updateCanvasDimensions &&
        !updateAnchor &&
        drawnEmptyKey !== undefined &&
        ruler._animationFrame === undefined &&
        !ruler._shouldUpdateDimensions &&
        !ruler._shouldUpdateAnchor &&
        !hasDecorations(ruler) &&
        emptyPictureKey(ruler) === drawnEmptyKey
      ) {
        return;
      }
      queueRefresh.call(this, updateCanvasDimensions, updateAnchor);
    };

    guarded.add(ruler);
    return true;
  } catch {
    return false;
  }
}
