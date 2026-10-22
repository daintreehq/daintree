import {
  resolveElementAtLocation,
  resolveElementByStructure,
  type DevLocation,
  type ResolvedElement,
} from "@daintreehq/svelte-source-model";
import type { SvelteEvidence } from "../../../../../../shared/elementPicker/evidence.js";
import type { SelectionObservation } from "../../../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../../outcomes.js";
import {
  isGenerated,
  metaPosition,
  rangeLocation,
  unreadableResult,
  type ReadSource,
  type SvelteJob,
} from "./context.js";

/** Element kinds whose tag the DOM keeps, so the rendered element's tag can witness the match. */
const TAGGED_KINDS: ReadonlySet<string> = new Set(["RegularElement", "TitleElement"]);

type Attempt =
  | { status: "ok"; element: ResolvedElement }
  /** The file contradicts the location: the one case the template's shape may still settle. */
  | { status: "contradicted" }
  | { status: "mismatch" }
  | { status: "unsupported" };

/**
 * The element at a location, proven rather than guessed: the location must
 * land exactly on an element's opening `<`, never the nearest one, and the
 * element there must be one the rendered node could be. The page's
 * coordinates carry no revision, so a selection captured before an HMR update
 * can land exactly on a different element in the new bytes; the tag is the
 * one independent witness to that. Same-tag shifts stay undetectable here.
 */
function attempt(
  job: SvelteJob,
  text: string,
  at: DevLocation,
  observation: SelectionObservation
): Attempt {
  const resolved = resolveElementAtLocation(text, at, job.parse);
  if (resolved.status !== "resolved") {
    switch (resolved.reason) {
      case "no-element-at-location":
        return { status: "contradicted" };
      // Not a claim the file contradicts: source the compiler cannot read, or
      // bytes the dev server never compiled.
      case "parse-failed":
      case "generated-file":
        return { status: "unsupported" };
      default:
        return { status: "mismatch" };
    }
  }
  const element = resolved.node;
  if (TAGGED_KINDS.has(element.kind)) {
    return element.tagName.toLowerCase() === observation.tagName.toLowerCase()
      ? { status: "ok", element }
      : { status: "contradicted" };
  }
  // `<svelte:element this={…}>` renders whatever its expression names.
  if (element.kind === "SvelteElement") return { status: "ok", element };
  // A component's call site, a slot, a special element: none of them is the
  // element that was rendered.
  return { status: "contradicted" };
}

/**
 * Where the element was written in its template, from the location the dev
 * runtime stamped on it, or failing that from its place in the template.
 *
 * On a hydrated page Svelte stamps an element with its neighbour's location
 * and leaves the template's tail unstamped; the shape the page reports still
 * identifies it. The shape is consulted only when the file contradicts the
 * stamp, or there is none: a stamp the file agrees with is kept as it is,
 * because the page can move an element after stamping it and its new place
 * says nothing about its source. Exact or nothing, and the placed location is
 * proven again like any other.
 */
export async function resolveTemplateLocation(
  job: SvelteJob,
  observation: SelectionObservation,
  candidate: Extract<SourceCandidate, { kind: "template-location" | "element-creation" }>,
  evidence: SvelteEvidence | undefined
): Promise<ResolutionResult> {
  // Inside `{@html}`, a canvas or a shadow root: rendered, but by no template Svelte can name.
  if (evidence?.unmapped) return unavailableResult(candidate, "unsupported");
  const structure = evidence?.structure;
  if (candidate.location === null && !structure) return unavailableResult(candidate, "unsupported");

  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const file = located.value;
  if (isGenerated(candidate.file, file.path) || !file.path.endsWith(".svelte")) {
    return unavailableResult(candidate, "unsupported");
  }
  const claimed = await job.readClaimed(candidate, file);
  if (!claimed.ok) return claimed.result;
  const source = claimed.source;
  if (source.text === null) return unreadableResult(candidate, "unsupported", source);
  const text = source.text;

  const stamp: DevLocation | null =
    candidate.location === null
      ? null
      : { file: candidate.file, ...metaPosition(candidate.location) };
  let outcome: Attempt =
    stamp === null ? { status: "contradicted" } : attempt(job, text, stamp, observation);
  let placed = false;
  if (
    outcome.status === "contradicted" &&
    structure &&
    (await job.sameFile(structure.file, candidate.file))
  ) {
    const shape = resolveElementByStructure(
      text,
      candidate.file,
      { frame: evidence?.ancestry[0] ?? null, path: structure.path, hint: stamp },
      job.parse
    );
    if (shape.status === "resolved") {
      const retried = attempt(job, text, shape.location, observation);
      if (retried.status === "ok") {
        outcome = retried;
        placed = true;
      }
    }
  }
  return answer(candidate, source, outcome, placed);
}

function answer(
  candidate: SourceCandidate,
  source: ReadSource,
  outcome: Attempt,
  placed: boolean
): ResolutionResult {
  if (outcome.status === "unsupported") return unreadableResult(candidate, "unsupported", source);
  if (outcome.status !== "ok") return unreadableResult(candidate, "mismatch", source);
  const { range } = outcome.element;
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: source.file, location: rangeLocation(source.text!, range.start, range.end) },
    fileRevision: source.revision,
    ...(placed ? { placedBy: "structure" as const } : {}),
  };
}

/** A file and nothing finer: read, so it is held to a revision, but not checked against anything in it. */
export async function resolveFileHint(
  job: SvelteJob,
  candidate: SourceCandidate
): Promise<ResolutionResult> {
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const file = located.value;
  if (isGenerated(candidate.file, file.path)) return unavailableResult(candidate, "unsupported");
  const claimed = await job.readClaimed(candidate, file);
  if (!claimed.ok) return claimed.result;
  return {
    state: "observed",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file, location: null },
    fileRevision: claimed.source.revision,
  };
}
