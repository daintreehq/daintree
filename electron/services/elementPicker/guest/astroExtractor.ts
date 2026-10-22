/// <reference lib="dom" />
/**
 * Astro's reader. Astro leaves no component instances in the page, only what
 * its compiler stamps on the markup of `.astro` files while the dev toolbar is
 * on: `data-astro-source-file`, the module's path, and `data-astro-source-loc`,
 * `line:column` with both 1-based and the column in UTF-16 units. The two on
 * the element itself are the only source this reads; a pair borrowed from an
 * ancestor would name another element's line. Without them it says the
 * location is not exposed, never why: the toolbar is one gate of several.
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

function evidenceOf(
  context: Context,
  file: AttributeState,
  loc: AttributeState
): FrameworkEvidence {
  return {
    kind: "generic",
    framework: "astro",
    fields: [
      { name: "boundary", value: context.boundary },
      { name: ASTRO_FILE_ATTRIBUTE, value: file },
      { name: ASTRO_LOC_ATTRIBUTE, value: loc },
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

export function describeAstro(element: Element): ExtractorContribution {
  const context = contextOf(element);
  const source = sourceOf(element);
  const evidence = evidenceOf(context, source.file, source.loc);
  const stamped = source.file !== "absent" || source.loc !== "absent";
  // Inside an island, or past where the walk could tell, an element Astro did
  // not stamp is another framework's to describe.
  if (!stamped && (context.boundary === "island" || context.boundary === "unknown")) {
    return { frameworkEvidence: [evidence] };
  }
  return {
    sourceCandidates: source.candidate === null ? [] : [source.candidate],
    capabilities: capabilitiesOf(source.candidate),
    frameworkEvidence: [evidence],
    // Stamped markup, slot content and the island element itself are Astro's
    // own. An unstamped element elsewhere is only Astro's for want of another
    // framework claiming it.
    ownership: stamped || context.boundary !== "page" ? "direct" : "fallback",
  };
}

/**
 * Selection only: everything here is attribute reads and a bounded walk, but
 * none of it improves a hover label, which the neutral picker already draws.
 */
export const astroExtractor: ElementPickerExtractor = {
  extract: (element, phase) => (phase === "selection" ? describeAstro(element) : null),
};
