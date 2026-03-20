import type { SidecarBounds } from "@shared/types";

function getZoomFactor(): number {
  try {
    const factor = window.electron?.window?.getZoomFactor?.();
    if (typeof factor === "number" && isFinite(factor) && factor > 0) {
      return factor;
    }
  } catch {
    // fall through
  }
  return 1;
}

export function getElementBoundsAsDip(element: Element | null): SidecarBounds | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const zoom = getZoomFactor();
  return {
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.ceil(rect.width * zoom),
    height: Math.ceil(rect.height * zoom),
  };
}

export function getSidecarPlaceholderBounds(): SidecarBounds | null {
  if (typeof document === "undefined") return null;
  return getElementBoundsAsDip(document.getElementById("sidecar-placeholder"));
}
