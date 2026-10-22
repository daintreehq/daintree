import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../../shared/elementPicker/resolution.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../outcomes.js";
import { SourceJob, unreadableResult } from "./sourceJob.js";
import { TAG_TYPE, TemplateIndex, rangeLocation, type TemplateTag } from "./vue/template.js";

/**
 * The Vue resolver: what a Vue dev build reported about a selected node,
 * checked against the `.vue` source it names. Any Vue 3 app, Nuxt included.
 *
 * What it reads in a request, as the Vue extractor reports it:
 *
 * - An element's `template-location`: the position `vite-plugin-vue-inspector`
 *   stamped on it. Answered `verified` with the element's range once the
 *   file's template has a tag of the element's name opening exactly there.
 * - A component record's `component-invocation`: the stamp on the tag that
 *   used it. Answered `verified` with the tag's range once a component tag
 *   opens exactly there; which file that tag binds to is not claimed.
 * - A `file-hint`, from a component's `type.__file` or the element's owner's:
 *   read and named, never placed. A file-only hint has no line to give.
 *
 * Anything else is `unsupported`, and so is a file in a dependency or in
 * Nuxt's generated output, which is never the user's to edit. Paths are
 * reported relative to the dev server's root or absolute; main locates them.
 */
export const vueResolver: HostSourceResolver = {
  framework: "vue",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const job = new SourceJob(request, access, signal);
    const templates = new TemplateIndex();
    const outcomes: ResolveResponse["outcomes"] = [];
    for (const observation of request.observations) {
      outcomes.push({
        elementId: observation.elementId,
        results: await resolveObservation(job, templates, observation),
      });
    }
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};

const GENERATED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".nuxt", ".output"]);

/** A string test, so it runs on the page's spelling and main's alike, on a case-insensitive filesystem too. */
export function isGenerated(...paths: string[]): boolean {
  return paths.some((file) =>
    file
      .replaceAll("\\", "/")
      .toLowerCase()
      .split("/")
      .some((segment) => GENERATED_SEGMENTS.has(segment))
  );
}

async function resolveObservation(
  job: SourceJob,
  templates: TemplateIndex,
  observation: SelectionObservation
): Promise<ResolutionResult[]> {
  const tagName = observation.tagName.toLowerCase();
  const isElement = (tag: TemplateTag) =>
    (tag.tagType === TAG_TYPE.element || tag.tagType === TAG_TYPE.component) &&
    tag.tag.toLowerCase() === tagName;
  const isComponent = (tag: TemplateTag) => tag.tagType === TAG_TYPE.component;

  // Work not begun when the job was withdrawn is `cancelled`, even where the
  // bytes it needs were already read: an answer is what the job finished.
  const answer = (
    candidate: SourceCandidate,
    work: () => Promise<ResolutionResult>
  ): Promise<ResolutionResult> =>
    job.cancelled ? Promise.resolve(unavailableResult(candidate, "cancelled")) : work();

  const results: ResolutionResult[] = [];
  for (const candidate of observation.sourceCandidates) {
    results.push(
      await answer(candidate, () =>
        candidate.kind === "template-location"
          ? resolveTag(job, templates, candidate, isElement)
          : candidate.kind === "file-hint"
            ? resolveFileHint(job, candidate)
            : Promise.resolve(unavailableResult(candidate, "unsupported"))
      )
    );
  }
  for (const record of observation.componentChain.components) {
    for (const candidate of record.sourceCandidates) {
      results.push(
        await answer(candidate, () =>
          candidate.kind === "component-invocation"
            ? resolveTag(job, templates, candidate, isComponent)
            : candidate.kind === "file-hint"
              ? resolveFileHint(job, candidate)
              : Promise.resolve(unavailableResult(candidate, "unsupported"))
        )
      );
    }
  }
  return results;
}

/**
 * The tag a stamp names, proven rather than guessed: the stamp must land
 * exactly where a tag opens in the template, and the tag there must be one
 * the claim could be about. The page's stamps carry no revision, so a
 * selection made before an edit can land on a different tag in the new bytes;
 * the tag's name and kind are the one independent witness to that, and a
 * same-tag shift stays undetectable here.
 */
async function resolveTag(
  job: SourceJob,
  templates: TemplateIndex,
  candidate: Extract<SourceCandidate, { kind: "template-location" | "component-invocation" }>,
  witness: (tag: TemplateTag) => boolean
): Promise<ResolutionResult> {
  const location = candidate.location;
  if (location === null) return unavailableResult(candidate, "unsupported");
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const file = located.value;
  if (isGenerated(candidate.file, file.path) || !file.path.toLowerCase().endsWith(".vue")) {
    return unavailableResult(candidate, "unsupported");
  }
  const claimed = await job.readClaimed(candidate, file);
  if (!claimed.ok) return claimed.result;
  const source = claimed.source;
  if (source.text === null) return unreadableResult(candidate, "unsupported", source);
  const found = await templates.tagAt(
    source.text,
    location.line - location.lineBase + 1,
    location.column - location.columnBase + 1
  );
  if (found.status === "unsupported") return unreadableResult(candidate, "unsupported", source);
  if (found.status === "absent" || !witness(found.tag)) {
    return unreadableResult(candidate, "mismatch", source);
  }
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: {
      file: source.file,
      location: rangeLocation(source.text, found.tag.start, found.tag.end),
    },
    fileRevision: source.revision,
  };
}

/** A file and nothing finer: read, so it is held to a revision, but not checked against anything in it. */
async function resolveFileHint(
  job: SourceJob,
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
