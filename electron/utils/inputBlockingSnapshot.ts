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
const MAX_COUNT = 10_000;

// Every string in the snapshot is drawn from a fixed vocabulary, mapped the
// same way in the preload and again in main. Tags and roles are authored
// strings — a custom element or a plugin's role could name anything — so only
// the shapes below survive.
const STANDARD_TAG = /^[a-z][a-z0-9]{0,15}$/;
const CUSTOM_ELEMENT_TAG = "custom-element";
const OTHER = "other";
const LAYER_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "application",
  "dialog",
  "document",
  "grid",
  "group",
  "listbox",
  "main",
  "menu",
  "menubar",
  "none",
  "presentation",
  "region",
  "tablist",
  "tabpanel",
  "toolbar",
  "tooltip",
  "tree",
]);
const POINTER_EVENTS: ReadonlySet<string> = new Set(["auto", "none"]);
const VISIBILITY_STATES: ReadonlySet<string> = new Set(["visible", "hidden", "prerender"]);

function normalizeTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.includes("-")) return CUSTOM_ELEMENT_TAG;
  return STANDARD_TAG.test(lower) ? lower : OTHER;
}

function normalizeRole(role: string | null): string | undefined {
  return role !== null && LAYER_ROLES.has(role) ? role : undefined;
}

// "" means the page had no body to read.
function normalizePointerEvents(value: string): string {
  return value === "" || POINTER_EVENTS.has(value) ? value : OTHER;
}

function normalizeVisibility(value: string): string {
  return VISIBILITY_STATES.has(value) ? value : OTHER;
}

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
    centerHit = {
      tag: normalizeTag(hit.tagName),
      coversViewport:
        rect.width >= win.innerWidth * COVERS_VIEWPORT_FRACTION &&
        rect.height >= win.innerHeight * COVERS_VIEWPORT_FRACTION,
    };
    const role = normalizeRole(hit.getAttribute("role"));
    if (role) centerHit.role = role;
  }

  return {
    bodyPointerEvents: normalizePointerEvents(body ? win.getComputedStyle(body).pointerEvents : ""),
    rootInert: root.hasAttribute("inert") || (body?.hasAttribute("inert") ?? false),
    inertCount: Math.min(countMatches(doc, "[inert]"), MAX_COUNT),
    scrollLocked: body?.hasAttribute("data-scroll-locked") ?? false,
    modalCount: Math.min(
      countMatches(doc, '[aria-modal="true"]') + countMatches(doc, "dialog:modal"),
      MAX_COUNT
    ),
    overlayClaims: Number.isInteger(claims) && claims > 0 ? Math.min(claims, MAX_COUNT) : 0,
    dragging: root.hasAttribute("data-dragging"),
    visibility: normalizeVisibility(doc.visibilityState),
    focused: doc.hasFocus(),
    centerHit,
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_COUNT)
    : null;
}

/**
 * Rebuild a renderer-reported snapshot from its validated fields, so nothing
 * the renderer adds or reshapes reaches the cache, the log or the bundle.
 * Strings are re-mapped onto the capture vocabulary rather than trusted.
 * Returns null when a required field is missing or malformed.
 */
export function parseInputBlockingSnapshot(value: unknown): RendererInputBlockingSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const inertCount = count(raw.inertCount);
  const modalCount = count(raw.modalCount);
  const overlayClaims = count(raw.overlayClaims);
  if (
    inertCount === null ||
    modalCount === null ||
    overlayClaims === null ||
    typeof raw.bodyPointerEvents !== "string" ||
    typeof raw.visibility !== "string" ||
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
    if (typeof hit.tag !== "string" || typeof hit.coversViewport !== "boolean") return null;
    centerHit = { tag: normalizeTag(hit.tag), coversViewport: hit.coversViewport };
    const role = typeof hit.role === "string" ? normalizeRole(hit.role) : undefined;
    if (role) centerHit.role = role;
  } else if (raw.centerHit !== null) {
    return null;
  }

  return {
    bodyPointerEvents: normalizePointerEvents(raw.bodyPointerEvents),
    rootInert: raw.rootInert,
    inertCount,
    scrollLocked: raw.scrollLocked,
    modalCount,
    overlayClaims,
    dragging: raw.dragging,
    visibility: normalizeVisibility(raw.visibility),
    focused: raw.focused,
    centerHit,
  };
}
