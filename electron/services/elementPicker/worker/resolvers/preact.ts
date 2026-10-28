import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../../shared/elementPicker/resolution.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import { observationCandidates, unavailableResult } from "../../outcomes.js";
import { PreactJob, unreadableResult } from "./preact/context.js";
import { dialectOf, namesElement, tagAt } from "./preact/jsx.js";

/**
 * The Preact resolver: the jsx-source positions a Preact page reported,
 * checked against the file each names. `RESOLVER_LOADERS` reaches it by its
 * own `import()`, so this module and the JavaScript parser it checks with load
 * only when a request carries a Preact candidate.
 *
 * What it reads in a request, as the Preact extractor reports it:
 *
 * - An element's `element-creation`: where `__source` says its JSX is
 *   written. Answered `verified` with the element's range once the file has an
 *   intrinsic element of that tag starting exactly there.
 * - A component record's `component-invocation`: where the vnode's own
 *   `__source` says it was invoked. Answered `verified` once the file has a
 *   component element starting there. Its tag is not held to the component's
 *   runtime name: an import alias or a member expression invokes `Card` as
 *   `<Alias>` or `<ui.Card>`, and the name says what the function calls
 *   itself, not how this file spells it.
 *
 * Preact captures no stack frames, so there is nothing to map; anything else
 * is `unsupported`. Paths are as the transform recorded them, absolute or
 * relative to the dev server's root; main locates them, so nothing here knows
 * where either root is.
 */
export const preactResolver: HostSourceResolver = {
  framework: "preact",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const job = new PreactJob(request, access, signal);
    const outcomes: ResolveResponse["outcomes"] = [];
    // One candidate at a time: candidates in one file share its read and its parse.
    for (const observation of request.observations) {
      const results: ResolutionResult[] = [];
      for (const candidate of observationCandidates(observation)) {
        // Work not begun when the job was withdrawn is `cancelled`, even where
        // the bytes it needs were already read.
        results.push(
          job.cancelled
            ? unavailableResult(candidate, "cancelled")
            : await resolveCandidate(job, observation, candidate)
        );
      }
      outcomes.push({ elementId: observation.elementId, results });
    }
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};

async function resolveCandidate(
  job: PreactJob,
  observation: SelectionObservation,
  candidate: SourceCandidate
): Promise<ResolutionResult> {
  if (candidate.kind !== "element-creation" && candidate.kind !== "component-invocation") {
    return unavailableResult(candidate, "unsupported");
  }
  if (candidate.extraction.kind !== "runtime-field") {
    return unavailableResult(candidate, "unsupported");
  }
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const dialect = dialectOf(located.value.path);
  if (dialect === null) return unavailableResult(candidate, "unsupported");
  const claimed = await job.readClaimed(candidate, located.value);
  if (!claimed.ok) return claimed.result;
  if (job.cancelled) return unavailableResult(candidate, "cancelled");
  const { source } = claimed;
  if (source.text === null) return unreadableResult(candidate, "unsupported", source);

  const offset = source.text.offsetOf(candidate.location);
  if (offset === null) return unreadableResult(candidate, "mismatch", source);
  const reading = tagAt(job.tree(source.file, source.text, dialect), source.text.text, offset);
  // An element the parse had to recover inside is one whose extent it cannot vouch for.
  if (reading.status === "broken") return unreadableResult(candidate, "unsupported", source);
  if (reading.status === "none") return unreadableResult(candidate, "mismatch", source);
  const { tag } = reading;
  const holds =
    candidate.kind === "element-creation"
      ? tag.kind === "intrinsic" && namesElement(tag.name, observation.tagName)
      : tag.kind === "component";
  if (!holds) return unreadableResult(candidate, "mismatch", source);
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: source.file, location: source.text.rangeOf(tag.from, tag.to) },
    fileRevision: source.revision,
  };
}
