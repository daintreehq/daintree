import type { DOMPurify } from "dompurify";
import type { Mermaid, MermaidConfig } from "mermaid";
import { yieldToScheduler } from "@/lib/schedulerYield";
import { readThemeSignature, resolveMermaidPalette, toMermaidThemeVariables } from "./mermaidTheme";

/**
 * The only place Mermaid is loaded or called. Kept out of components on
 * purpose: the dynamic imports and try/catch here would bail the React
 * Compiler for any component that held them.
 *
 * Mermaid is several megabytes and is only imported the first time a document
 * actually asks for a diagram. Renders run one at a time — Mermaid keeps its
 * config and temporary DOM in module state — and yield to the scheduler
 * between diagrams, so a document with dozens of them never holds the main
 * thread for longer than one diagram takes.
 */

export type MermaidRenderResult =
  /** `svg` is a template: every id in it is derived from `templateId`. */
  | { ok: true; svg: string; templateId: string }
  /**
   * `transient` marks an outcome that says nothing about the diagram — the
   * theme moved under a queued job, nobody wanted it any more, or the chunk
   * would not load — so it is neither cached nor shown.
   */
  | { ok: false; transient?: true };

export interface MermaidRenderRequest {
  result: Promise<MermaidRenderResult>;
  /** Drops this caller's interest; a job nobody wants is skipped when reached. */
  cancel: () => void;
}

/** Diagram sources past this size fall back to their text without being parsed. */
export const MERMAID_MAX_SOURCE_CHARS = 50_000;

/**
 * Keys a diagram's `%%{init}%%` directive or frontmatter may not override.
 * Mermaid's default list covers only its own security switches; everything
 * that decides how labels are emitted, what CSS is injected, which colors are
 * used and how ids are minted belongs to the host.
 */
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "dompurifyConfig",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "look",
  "handDrawnSeed",
  "arrowMarkerAbsolute",
  "deterministicIds",
  "deterministicIDSeed",
  "legacyMathML",
  "forceLegacyMathML",
  "logLevel",
];

const TRANSIENT: MermaidRenderResult = { ok: false, transient: true };
const FAILED: MermaidRenderResult = { ok: false };

interface MermaidRuntime {
  mermaid: Mermaid;
  purify: DOMPurify;
  sanitize: (purify: DOMPurify, svg: string) => string | null;
}

let runtimePromise: Promise<MermaidRuntime> | null = null;

function loadRuntime(): Promise<MermaidRuntime> {
  if (!runtimePromise) {
    const loading = Promise.all([
      import("mermaid"),
      import("dompurify"),
      import("./sanitizeMermaidSvg"),
    ]).then(([mermaidModule, purifyModule, sanitizeModule]) => ({
      mermaid: mermaidModule.default,
      purify: purifyModule.default,
      sanitize: sanitizeModule.sanitizeMermaidSvg,
    }));
    // A failed chunk load (a rebuild replaced the hashes, say) must not poison
    // every later attempt.
    loading.catch(() => {
      if (runtimePromise === loading) runtimePromise = null;
    });
    runtimePromise = loading;
  }
  return runtimePromise;
}

function buildConfig(): MermaidConfig {
  const palette = resolveMermaidPalette();
  return {
    startOnLoad: false,
    logLevel: "fatal",
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_SOURCE_CHARS,
    maxEdges: 2000,
    theme: "base",
    darkMode: palette.darkMode,
    fontFamily: palette.fontFamily,
    themeVariables: toMermaidThemeVariables(palette),
    secure: SECURE_KEYS,
  };
}

const CACHE_MAX_ENTRIES = 48;
const CACHE_MAX_CHARS = 8_000_000;
const cache = new Map<string, MermaidRenderResult>();
let cacheChars = 0;

function cacheKey(source: string, themeSignature: string): string {
  return `${themeSignature}\n${source}`;
}

function resultSize(key: string, result: MermaidRenderResult): number {
  return key.length + (result.ok ? result.svg.length : 0);
}

function remember(key: string, result: MermaidRenderResult): void {
  const size = resultSize(key, result);
  if (size > CACHE_MAX_CHARS) return;
  cache.set(key, result);
  cacheChars += size;
  for (const [oldestKey, oldest] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheChars <= CACHE_MAX_CHARS) break;
    cache.delete(oldestKey);
    cacheChars -= resultSize(oldestKey, oldest);
  }
}

/** Synchronous cache read, so a remount paints the diagram without a flash of source. */
export function peekMermaidRender(
  source: string,
  themeSignature: string
): MermaidRenderResult | undefined {
  const key = cacheKey(source, themeSignature);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
  }
  return cached;
}

interface Job {
  result: Promise<MermaidRenderResult>;
  waiters: number;
}

const jobs = new Map<string, Job>();
let queue: Promise<unknown> = Promise.resolve();
let appliedThemeSignature: string | null = null;
let renderSequence = 0;
// Ids are baked into the SVG's CSS and marker references, and the same
// template can be mounted more than once; a random stem keeps the template's
// id from matching anything an author could have typed into a label.
const idStem = `dmm${crypto.randomUUID().slice(0, 8)}`;

function removeStrayRenderNodes(id: string): void {
  // Mermaid renders into a temporary node under <body>; a render that throws
  // part-way can leave it behind.
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(id)?.remove();
}

async function renderNow(
  key: string,
  source: string,
  themeSignature: string
): Promise<MermaidRenderResult> {
  await yieldToScheduler();
  // Checked after the yield, when this job is really about to run: a job its
  // requester dropped, or one queued before the theme changed, is not worth a
  // layout pass (and the latter would cache colors under the wrong signature).
  if ((jobs.get(key)?.waiters ?? 0) === 0) return TRANSIENT;
  if (readThemeSignature() !== themeSignature) return TRANSIENT;

  let runtime: MermaidRuntime;
  try {
    runtime = await loadRuntime();
  } catch {
    return TRANSIENT;
  }
  const { mermaid, purify, sanitize } = runtime;
  if (appliedThemeSignature !== themeSignature) {
    mermaid.initialize(buildConfig());
    appliedThemeSignature = themeSignature;
  }
  const id = `${idStem}${++renderSequence}`;
  try {
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    if (!parsed) return FAILED;
    const { svg } = await mermaid.render(id, source);
    const clean = sanitize(purify, svg);
    return clean === null ? FAILED : { ok: true, svg: clean, templateId: id };
  } catch {
    return FAILED;
  } finally {
    removeStrayRenderNodes(id);
  }
}

/**
 * Asks for one diagram as sanitized SVG. The result never rejects: a syntax
 * error, an unsupported diagram or a failed chunk load all resolve to
 * `{ ok: false }` and the caller shows the source instead. Requests for the
 * same diagram share one job.
 */
export function requestMermaidRender(source: string, themeSignature: string): MermaidRenderRequest {
  const key = cacheKey(source, themeSignature);
  const cached = peekMermaidRender(source, themeSignature);
  if (cached !== undefined) return { result: Promise.resolve(cached), cancel: () => {} };
  if (source.length > MERMAID_MAX_SOURCE_CHARS) {
    return { result: Promise.resolve(FAILED), cancel: () => {} };
  }

  let job = jobs.get(key);
  if (!job) {
    const result = queue
      .then(() => renderNow(key, source, themeSignature))
      .catch(() => FAILED)
      .then((outcome) => {
        if (jobs.get(key) === created) jobs.delete(key);
        if (!(!outcome.ok && outcome.transient)) remember(key, outcome);
        return outcome;
      });
    const created: Job = { result, waiters: 0 };
    job = created;
    jobs.set(key, created);
    queue = result;
  }
  const owned = job;
  owned.waiters += 1;
  let cancelled = false;
  return {
    result: owned.result,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      owned.waiters -= 1;
    },
  };
}

/**
 * Stamps a template with ids unique to one mounted diagram. Two mounts of the
 * same template would otherwise share marker and style ids, and a copy in a
 * hidden pane can take the visible copy's arrowheads with it.
 */
export function instantiateMermaidSvg(
  result: Extract<MermaidRenderResult, { ok: true }>,
  instanceId: string
): string {
  return result.svg.split(result.templateId).join(instanceId);
}

let instanceSequence = 0;

export function nextMermaidInstanceId(): string {
  return `daintree-mermaid-${++instanceSequence}`;
}

export function _resetMermaidRendererForTests(): void {
  cache.clear();
  cacheChars = 0;
  jobs.clear();
  queue = Promise.resolve();
  appliedThemeSignature = null;
  renderSequence = 0;
  runtimePromise = null;
}
