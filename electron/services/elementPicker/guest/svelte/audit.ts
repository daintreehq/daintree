/// <reference lib="dom" />
/**
 * What the page's Svelte metadata supports, and whether it has any at all.
 * The extractor is only installed where something said "Svelte", so a page
 * with none of Svelte's dev stamps is a Svelte page built without them — and
 * a silent dead picker reads as a bug in Daintree. Saying so while the page
 * is still hydrating is worse, a warning that contradicts the working
 * selection under it, so the verdict waits for the document to settle.
 */

import type { ExtractorNotice } from "../../guestChannel.js";
import { SVELTE_LIMITS, readFrame, readLoc, readMeta, frameObjects } from "./meta.js";

/** Stamped elements the capability probe looks at before it answers. */
const PROBE_SAMPLE = 64;
/**
 * How long a finished document has to stay without dev metadata before the
 * audit says so. SvelteKit hydrates after `load`: its entry is a chain of
 * dev-server module fetches, so `readyState === "complete"` arrives while the
 * server-rendered markup still has no `__svelte_meta`.
 */
export const AUDIT_SETTLE_MS = 2_500;
/** A page that is visibly served by Vite gets longer to hydrate on a cold start. */
export const AUDIT_DEV_SETTLE_MS = 15_000;

/**
 * `__svelte_meta` is a private detail of Svelte's dev runtime, and a major is
 * not a promise about its shape: a version that stamps elements but names no
 * parent chain, or stamps a chain this reader cannot follow, must narrow what
 * the picker claims rather than be taken for the version it was written
 * against.
 */
export interface MetadataProbe {
  /** Some stamp carries a readable template location. */
  locations: boolean;
  /** Some stamp's chain names a component a trail could select, not only blocks. */
  ancestry: boolean;
}

const DEV_SERVER_PATHS = [
  "/@vite/client",
  "/@fs/",
  "/.svelte-kit/generated/",
  "/node_modules/.vite/",
];

function namesDevServerPath(value: string | null | undefined): boolean {
  return typeof value === "string" && DEV_SERVER_PATHS.some((part) => value.includes(part));
}

/**
 * SvelteKit's dev page has no `<script src="/@vite/client">`: its inline start
 * script imports the client runtime through `/@fs/` and the generated app, and
 * Vite's client arrives as one of those imports. The module fetches are the
 * dependable evidence, with the markup as a fallback.
 */
function looksLikeDevServer(): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  try {
    if (
      scope.__vite_plugin_react_preamble_installed__ !== undefined ||
      scope.__vite__ !== undefined
    ) {
      return true;
    }
  } catch {
    // A throwing global is no evidence either way.
  }
  try {
    const entries =
      typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
        ? performance.getEntriesByType("resource")
        : [];
    for (let index = 0; index < entries.length && index < SVELTE_LIMITS.scan; index += 1) {
      if (namesDevServerPath(entries[index]?.name)) return true;
    }
  } catch {
    // Resource timing is evidence, not a requirement.
  }
  const scripts = document.getElementsByTagName("script");
  for (let index = 0; index < scripts.length && index < 200; index += 1) {
    const script = scripts[index];
    if (script === undefined) continue;
    if (namesDevServerPath(script.getAttribute("src"))) return true;
    if (script.src === "" && namesDevServerPath((script.textContent ?? "").slice(0, 4096))) {
      return true;
    }
  }
  return false;
}

/**
 * `found` and `complete` are separate: an unfinished scan proves nothing.
 * `stamped` is any stamp at all, readable or not, which the probe then reads.
 */
function scanForSvelteMeta(): { found: boolean; complete: boolean; stamped: boolean } {
  const all = document.getElementsByTagName("*");
  const limit = Math.min(all.length, SVELTE_LIMITS.scan);
  let stamped = false;
  for (let index = 0; index < limit; index += 1) {
    const element = all[index];
    if (element === undefined || readMeta(element) === null) continue;
    if (readLoc(element) !== null) return { found: true, complete: true, stamped: true };
    stamped = true;
  }
  return { found: false, complete: all.length <= SVELTE_LIMITS.scan, stamped };
}

export interface MetadataAudit {
  /** The probe's answer, sweeping for it once per document; null until a stamp exists. */
  probe(): MetadataProbe | null;
  /** The answer already in hand, for a hover that must not sweep. */
  probed(): MetadataProbe | null;
  start(): void;
  /** Called on every structural change the extractor sees. */
  onMutation(): void;
  dispose(): void;
}

export function createMetadataAudit(notify: (notice: ExtractorNotice) => void): MetadataAudit {
  let disposed = false;
  let auditDone = false;
  let auditTimer: ReturnType<typeof setTimeout> | null = null;
  let auditStartedAt = 0;
  let answer: MetadataProbe | null = null;
  const onLoad = (): void => auditMapping();

  /**
   * Probed over the stamped elements found, not the first one alone: the root
   * of a page has no component above it, so one element cannot speak for the
   * chain. Settled once a stamp has been seen. Asked only by a selection that
   * already holds a stamp and by the audit's one verdict, so a page without
   * any is never swept for it per mutation.
   */
  function probe(): MetadataProbe | null {
    if (answer !== null || disposed) return answer;
    const all = document.getElementsByTagName("*");
    const limit = Math.min(all.length, SVELTE_LIMITS.scan);
    let stamped = 0;
    let locations = false;
    let ancestry = false;
    for (let index = 0; index < limit && stamped < PROBE_SAMPLE; index += 1) {
      const element = all[index];
      if (element === undefined) continue;
      const meta = readMeta(element);
      if (meta === null) continue;
      stamped += 1;
      if (readLoc(element) !== null) locations = true;
      // Ancestry means a component the trail can name, not merely a readable
      // frame: a chain of block frames gives a crumb nothing to select.
      if (
        !ancestry &&
        frameObjects(meta).some((object) => {
          const frame = readFrame(object);
          return frame !== null && frame.type === "component" && frame.componentTag !== undefined;
        })
      ) {
        ancestry = true;
      }
      if (locations && ancestry) break;
    }
    if (stamped > 0) answer = { locations, ancestry };
    return answer;
  }

  function clearAuditTimer(): void {
    if (auditTimer !== null) {
      clearTimeout(auditTimer);
      auditTimer = null;
    }
  }

  function auditMapping(): void {
    if (disposed || auditDone) return;
    const scan = scanForSvelteMeta();
    if (scan.found) {
      auditDone = true;
      clearAuditTimer();
      return;
    }
    // Stamps seen on any look are remembered: hydration can replace a node
    // that carried one before the verdict comes due. Only then is the page
    // swept a second time, and only until the probe has its answer.
    if (scan.stamped) probe();
    // A page that has not finished loading, or a document too big to sweep,
    // is not evidence of a production build. Stay silent and look again.
    if (scan.complete && document.readyState === "complete" && auditTimer === null) {
      if (auditStartedAt === 0) auditStartedAt = Date.now();
      auditTimer = setTimeout(confirmMissingMapping, AUDIT_SETTLE_MS);
    }
  }

  function confirmMissingMapping(): void {
    auditTimer = null;
    if (auditDone || disposed) return;
    const scan = scanForSvelteMeta();
    if (scan.found) {
      auditDone = true;
      return;
    }
    if (!scan.complete || document.readyState !== "complete") return;
    const dev = looksLikeDevServer();
    if (dev && Date.now() - auditStartedAt < AUDIT_DEV_SETTLE_MS) {
      auditTimer = setTimeout(confirmMissingMapping, AUDIT_SETTLE_MS);
      return;
    }
    // Stamps that exist but cannot be read are the probe's to describe; an
    // absence verdict on top would contradict it.
    const stamps = probe();
    auditDone = true;
    window.removeEventListener("load", onLoad);
    if (stamps !== null) return;
    notify(dev ? "metadata-unavailable" : "not-dev-build");
  }

  return {
    probe,
    probed: () => answer,
    start() {
      if (disposed) return;
      // The verdict waits for a complete document; a page whose last resource
      // lands after the extractor arrived would otherwise never be judged.
      if (document.readyState !== "complete") window.addEventListener("load", onLoad);
      auditMapping();
    },
    onMutation: auditMapping,
    dispose() {
      disposed = true;
      clearAuditTimer();
      window.removeEventListener("load", onLoad);
    },
  };
}
