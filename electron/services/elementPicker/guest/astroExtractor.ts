/// <reference lib="dom" />
/**
 * Astro's reader. Astro leaves no component instances in the page, only what
 * its compiler stamps on the markup of `.astro` files while the dev toolbar is
 * on: `data-astro-source-file`, the module's path, and `data-astro-source-loc`,
 * `line:column` with both 1-based and the column in UTF-16 units. The toolbar
 * then takes both off every element soon after load (its Audit app keeps them
 * in a private map), so the pair is read from the element itself while it is
 * still there, and otherwise from the element's counterpart in the markup the
 * dev server served (`servedDocument.ts`), never from an ancestor: a borrowed
 * pair would name another element's line. Without one it says the location is
 * not exposed, never why: the toolbar is one gate of several.
 *
 * An island's interior is its renderer's to describe, so there Astro hands
 * off: it sends evidence alone (which framework hydrates the island, when,
 * and under what name), never the island's props.
 */

import type {
  FrameworkEvidence,
  GenericEvidence,
} from "../../../../shared/elementPicker/evidence.js";
import type { Capabilities, Capability } from "../../../../shared/elementPicker/observation.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { ANCESTRY_LIMIT, islandRenderer, parentAcrossShadow } from "./detectors.js";
import type { ElementPickerExtractor } from "./registry.js";
import { createServedDocument, type ServedDocument } from "./servedDocument.js";
import type { ExtractorContribution } from "./types.js";

/** Restated from the shared schemas: a value import would bundle zod into the page. */
const LIMITS = { file: 2048, coordinate: 10_000_000, opts: 1024 } as const;

export const ASTRO_FILE_ATTRIBUTE = "data-astro-source-file";
export const ASTRO_LOC_ATTRIBUTE = "data-astro-source-loc";

const LOC = /^(\d{1,8}):(\d{1,8})$/;
const CLIENT = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,127}$/;

const AVAILABLE: Capability = { state: "available" };
const NOT_EXPOSED: Capability = { state: "unavailable", reason: "not-exposed" };

/** Where the element sits relative to Astro's own wrappers. */
type Boundary = "page" | "slot" | "island" | "island-host" | "unknown";

/** `unusable`: the attribute is there, but not in a form that can name a file or a position. */
type AttributeState = "present" | "absent" | "unusable";

/**
 * What the served markup said of an element that carries no stamp of its own:
 * `matched` its counterpart there is stamped, `unstamped` it is not, and the
 * rest are `ServedLookup`'s.
 */
type ServedState = "matched" | "unstamped" | "unmatched" | "unavailable";

interface Context {
  boundary: Boundary;
  /** The island the element is in or is, when the walk reached one. */
  island: Element | null;
}

/**
 * The nearest of Astro's wrappers above the element. A slot is Astro content
 * passed into an island, so the walk carries on past one to name the island it
 * sits in. A walk that hits its bound has not shown the element is outside an
 * island, and says so.
 */
function contextOf(element: Element): Context {
  if (element.localName === "astro-island") return { boundary: "island-host", island: element };
  let boundary: Boundary | null = null;
  let node = parentAcrossShadow(element);
  for (let depth = 1; node !== null && depth < ANCESTRY_LIMIT; depth += 1) {
    const tag = node.localName;
    if (tag === "astro-island") return { boundary: boundary ?? "island", island: node };
    if (boundary === null && (tag === "astro-slot" || tag === "astro-static-slot")) {
      boundary = "slot";
    }
    node = parentAcrossShadow(node);
  }
  return { boundary: boundary ?? (node === null ? "page" : "unknown"), island: null };
}

function coordinate(text: string | undefined): number | null {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= LIMITS.coordinate ? value : null;
}

function sourceOf(element: Element): {
  file: AttributeState;
  loc: AttributeState;
  candidate: SourceCandidate | null;
} {
  const file = element.getAttribute(ASTRO_FILE_ATTRIBUTE);
  const loc = element.getAttribute(ASTRO_LOC_ATTRIBUTE);
  const match = loc === null ? null : LOC.exec(loc);
  const line = coordinate(match?.[1]);
  const column = coordinate(match?.[2]);
  const position = line !== null && column !== null ? { line, column } : null;
  // Never cut down to fit: a truncated path is a different path.
  const fileUsable = file !== null && file.length > 0 && file.length <= LIMITS.file;
  const states = {
    file: file === null ? "absent" : fileUsable ? "present" : "unusable",
    loc: loc === null ? "absent" : position !== null ? "present" : "unusable",
  } as const;
  if (!fileUsable) return { ...states, candidate: null };
  if (position === null) {
    return {
      ...states,
      candidate: {
        kind: "file-hint",
        candidateId: "astro-source",
        framework: "astro",
        extraction: { kind: "attribute", attribute: ASTRO_FILE_ATTRIBUTE },
        file,
      },
    };
  }
  return {
    ...states,
    candidate: {
      kind: "template-location",
      candidateId: "astro-source",
      framework: "astro",
      extraction: { kind: "attribute", attribute: ASTRO_LOC_ATTRIBUTE },
      file,
      location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...position },
    },
  };
}

/** `opts` is `{"name": …, "value": …}`; only the name is taken, and only from a bounded read. */
function optsName(island: Element): string | null {
  const opts = island.getAttribute("opts");
  if (opts === null || opts.length > LIMITS.opts) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const name: unknown = (parsed as Record<string, unknown>).name;
  return typeof name === "string" && IDENTIFIER.test(name) ? name : null;
}

/**
 * What the island says about itself, each field named for the attribute it was
 * read from. `props` is never read: it is the page's data. The renderer is
 * reported by the framework it names in the detectors' fixed table, never as
 * the URL.
 */
function islandFields(island: Element): GenericEvidence["fields"] {
  const fields: GenericEvidence["fields"] = [];
  const renderer = island.getAttribute("renderer-url");
  fields.push({
    name: "islandRenderer",
    value: renderer === null ? null : (islandRenderer(renderer) ?? "unrecognized"),
  });
  const client = island.getAttribute("client");
  if (client !== null && CLIENT.test(client)) {
    fields.push({ name: "astro-island[client]", value: client });
  }
  const exported = island.getAttribute("component-export");
  if (exported !== null && IDENTIFIER.test(exported)) {
    fields.push({ name: "astro-island[component-export]", value: exported });
  }
  const name = optsName(island);
  if (name !== null) fields.push({ name: "astro-island[opts].name", value: name });
  return fields;
}

/** The attribute fields say what the live element carries; `servedDocument`, where the pair came from otherwise. */
function evidenceOf(
  context: Context,
  file: AttributeState,
  loc: AttributeState,
  served: ServedState | null
): FrameworkEvidence {
  return {
    kind: "generic",
    framework: "astro",
    fields: [
      { name: "boundary", value: context.boundary },
      { name: ASTRO_FILE_ATTRIBUTE, value: file },
      { name: ASTRO_LOC_ATTRIBUTE, value: loc },
      ...(served === null ? [] : [{ name: "servedDocument", value: served }]),
      ...(context.island === null ? [] : islandFields(context.island)),
    ],
  };
}

function capabilitiesOf(candidate: SourceCandidate | null): Capabilities {
  return {
    // Astro components leave nothing in the page to name or select them by.
    names: NOT_EXPOSED,
    chain: NOT_EXPOSED,
    componentSelection: NOT_EXPOSED,
    file: candidate === null ? NOT_EXPOSED : AVAILABLE,
    line: candidate?.kind === "template-location" ? AVAILABLE : NOT_EXPOSED,
    // The compiler marks one point near the opening tag, never the element's extent.
    exactRange: NOT_EXPOSED,
  };
}

function isStamped(source: { file: AttributeState; loc: AttributeState }): boolean {
  return source.file !== "absent" || source.loc !== "absent";
}

/**
 * `served` is the markup the dev server sent, when the host could read it
 * back; without it only the live element's own attributes are read.
 */
export function describeAstro(element: Element, served?: ServedDocument): ExtractorContribution {
  const context = contextOf(element);
  const live = sourceOf(element);
  const stamped = isStamped(live);
  // Inside an island, or past where the walk could tell, an element Astro did
  // not stamp is another framework's to describe.
  if (!stamped && (context.boundary === "island" || context.boundary === "unknown")) {
    return { frameworkEvidence: [evidenceOf(context, live.file, live.loc, null)] };
  }
  // Asked only when the element carries neither attribute: one it does carry,
  // even unusable, is the page's word now, not to be replaced by older markup.
  let candidate = live.candidate;
  let servedState: ServedState | null = null;
  if (!stamped && served !== undefined) {
    const found = served.lookup(element);
    if (typeof found === "string") {
      servedState = found;
    } else {
      const source = sourceOf(found);
      servedState = isStamped(source) ? "matched" : "unstamped";
      candidate = source.candidate;
    }
  }
  return {
    sourceCandidates: candidate === null ? [] : [candidate],
    capabilities: capabilitiesOf(candidate),
    frameworkEvidence: [evidenceOf(context, live.file, live.loc, servedState)],
    // Stamped markup, slot content and the island element itself are Astro's
    // own. An unstamped element elsewhere is only Astro's for want of another
    // framework claiming it.
    ownership:
      stamped || servedState === "matched" || context.boundary !== "page" ? "direct" : "fallback",
  };
}

/**
 * Selection only: everything here is attribute reads and bounded walks, but
 * none of it improves a hover label, which the neutral picker already draws.
 * Declared, so a hover's silence is not taken for finding nothing.
 */
export const astroExtractor: ElementPickerExtractor = {
  selectionOnly: true,
  extract: (element, phase) => (phase === "selection" ? describeAstro(element) : null),
};

/**
 * The installed reader: the same, with the served markup the host handed in
 * (`api.served`, absent or null when it read nothing) to fall back on. The
 * parsed copy goes when the extractor does.
 */
export function createAstroExtractor(served: unknown): ElementPickerExtractor {
  const document = createServedDocument(served);
  return {
    selectionOnly: true,
    extract: (element, phase) => (phase === "selection" ? describeAstro(element, document) : null),
    dispose: () => document.dispose(),
  };
}
