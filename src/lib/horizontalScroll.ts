export interface ScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface HorizontalScrollState {
  isOverflowing: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

const EPSILON = 1;

export function getHorizontalScrollState(metrics: ScrollMetrics): HorizontalScrollState {
  const isOverflowing = metrics.scrollWidth > metrics.clientWidth + EPSILON;
  const canScrollLeft = isOverflowing && metrics.scrollLeft > EPSILON;
  const canScrollRight =
    isOverflowing && metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - EPSILON;
  return { isOverflowing, canScrollLeft, canScrollRight };
}

export function calculateScrollAmount(clientWidth: number): number {
  const minScroll = 200;
  const maxScroll = 600;
  const preferredScroll = clientWidth * 0.8;
  return Math.max(minScroll, Math.min(preferredScroll, maxScroll));
}

export interface WheelDeltaInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

// Chromium's own pixels-per-line step for line-mode wheels.
const WHEEL_LINE_PX = 40;

/**
 * Pixels a horizontal-only rail should move for a wheel event, or 0 when the
 * event is not a plain vertical wheel notch. Anything carrying `deltaX` is a
 * trackpad pan (or a tilt wheel) the browser already scrolls natively, and a
 * `ctrlKey` wheel is Chromium's pinch-zoom — neither is remapped.
 */
export function getWheelHorizontalDelta(event: WheelDeltaInput, pageWidth: number): number {
  if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return 0;
  if (event.deltaMode === 1) return event.deltaY * WHEEL_LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * pageWidth;
  return event.deltaY;
}
