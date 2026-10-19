import type { RendererInputBlockingSnapshot } from "../../shared/types/ipc/system.js";

// Structural slices of the DOM the preload passes in, so this compiles under
// the main-process tsconfig (no DOM lib) and runs against jsdom in tests.
interface SnapshotElement {
  tagName: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
}

interface SnapshotDocument {
  documentElement: SnapshotElement;
  body: SnapshotElement | null;
  visibilityState: string;
  hasFocus(): boolean;
  querySelectorAll(selector: string): { length: number };
  elementFromPoint(x: number, y: number): SnapshotElement | null;
}

interface SnapshotWindow {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(element: SnapshotElement): { pointerEvents: string };
}

const OVERLAY_CLAIMS_ATTRIBUTE = "data-overlay-claims";
const COVERS_VIEWPORT_FRACTION = 0.9;

function countMatches(doc: SnapshotDocument, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    // `:modal` is Chromium 105+; jsdom and older engines reject it.
    return 0;
  }
}

export function captureInputBlockingSnapshot(
  doc: SnapshotDocument,
  win: SnapshotWindow
): RendererInputBlockingSnapshot {
  const root = doc.documentElement;
  const body = doc.body;
  const claims = Number(root.getAttribute(OVERLAY_CLAIMS_ATTRIBUTE));

  let centerHit: RendererInputBlockingSnapshot["centerHit"] = null;
  const hit = doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2);
  if (hit) {
    const rect = hit.getBoundingClientRect();
    const role = hit.getAttribute("role");
    centerHit = {
      tag: hit.tagName.toLowerCase(),
      coversViewport:
        rect.width >= win.innerWidth * COVERS_VIEWPORT_FRACTION &&
        rect.height >= win.innerHeight * COVERS_VIEWPORT_FRACTION,
    };
    if (role) centerHit.role = role;
  }

  return {
    bodyPointerEvents: body ? win.getComputedStyle(body).pointerEvents : "",
    rootInert: root.hasAttribute("inert") || (body?.hasAttribute("inert") ?? false),
    inertCount: countMatches(doc, "[inert]"),
    scrollLocked: body?.hasAttribute("data-scroll-locked") ?? false,
    modalCount: countMatches(doc, '[aria-modal="true"]') + countMatches(doc, "dialog:modal"),
    overlayClaims: Number.isFinite(claims) && claims > 0 ? claims : 0,
    dragging: root.hasAttribute("data-dragging"),
    visibility: doc.visibilityState,
    focused: doc.hasFocus(),
    centerHit,
  };
}

const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_COUNT = 10_000;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_COUNT)
    : null;
}

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

/**
 * Rebuild a renderer-reported snapshot from its validated fields, so nothing
 * the renderer adds or reshapes reaches the cache, the log or the bundle.
 * Returns null when a required field is missing or malformed.
 */
export function parseInputBlockingSnapshot(value: unknown): RendererInputBlockingSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const inertCount = count(raw.inertCount);
  const modalCount = count(raw.modalCount);
  const overlayClaims = count(raw.overlayClaims);
  const bodyPointerEvents = raw.bodyPointerEvents === "" ? "" : token(raw.bodyPointerEvents);
  const visibility = token(raw.visibility);
  if (
    inertCount === null ||
    modalCount === null ||
    overlayClaims === null ||
    bodyPointerEvents === null ||
    visibility === null ||
    typeof raw.rootInert !== "boolean" ||
    typeof raw.scrollLocked !== "boolean" ||
    typeof raw.dragging !== "boolean" ||
    typeof raw.focused !== "boolean"
  ) {
    return null;
  }

  let centerHit: RendererInputBlockingSnapshot["centerHit"] = null;
  if (raw.centerHit && typeof raw.centerHit === "object") {
    const hit = raw.centerHit as Record<string, unknown>;
    const tag = token(hit.tag);
    if (tag === null || typeof hit.coversViewport !== "boolean") return null;
    centerHit = { tag, coversViewport: hit.coversViewport };
    const role = token(hit.role);
    if (role !== null) centerHit.role = role;
  } else if (raw.centerHit !== null) {
    return null;
  }

  return {
    bodyPointerEvents,
    rootInert: raw.rootInert,
    inertCount,
    scrollLocked: raw.scrollLocked,
    modalCount,
    overlayClaims,
    dragging: raw.dragging,
    visibility,
    focused: raw.focused,
    centerHit,
  };
}
