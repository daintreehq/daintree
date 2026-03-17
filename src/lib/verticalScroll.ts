export interface VerticalScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface VerticalScrollState {
  isOverflowing: boolean;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

const EPSILON = 1;

export function getVerticalScrollState(metrics: VerticalScrollMetrics): VerticalScrollState {
  const isOverflowing = metrics.scrollHeight > metrics.clientHeight + EPSILON;
  const canScrollUp = isOverflowing && metrics.scrollTop > EPSILON;
  const canScrollDown =
    isOverflowing && metrics.scrollTop + metrics.clientHeight < metrics.scrollHeight - EPSILON;
  return { isOverflowing, canScrollUp, canScrollDown };
}
