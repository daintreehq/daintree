import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../../shared/elementPicker/resolution.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../outcomes.js";
import { isStackFrame, resolveDefinition, resolveFrames } from "./react/frames.js";
import { ReactJob, type StackFrameCandidate } from "./react/job.js";

/**
 * The React resolver: the frames a React 19 dev build captured when it made a
 * selected node's elements, mapped through the dev server's source maps and
 * checked against the files they map to. Any React app whose dev server
 * serves maps; this module and the parser it reads files with load only when
 * a request carries a React candidate.
 *
 * What it reads in a request, as the React extractor reports it:
 *
 * - The element's `element-creation` frames: the `_debugStack` of its own
 *   fiber. Answered `verified` with the JSX element's range, where the file
 *   has one with the element's tag at the first frame of the app's own code.
 * - A component record's `component-invocation` frames: the stack of the
 *   element that made this instance, so its call site. Answered the same way,
 *   with a component tag there.
 * - A record's `component-definition`: the frame React called the component
 *   through, from an element it made itself. Answered `verified` with the
 *   declaration of the function that frame runs in.
 *
 * The call site and the definition are separate claims about separate places,
 * and neither stands in for the other. Anything else is `unsupported`.
 */
export const reactResolver: HostSourceResolver = {
  framework: "react",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const job = new ReactJob(request, access, signal);
    const outcomes: ResolveResponse["outcomes"] = [];
    // One observation at a time: frames in one module share its map, and
    // frames in one file its read and its parse.
    for (const observation of request.observations) {
      outcomes.push({
        elementId: observation.elementId,
        results: await resolveObservation(job, observation),
      });
    }
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};

function framesOf(candidates: SourceCandidate[], kind: SourceCandidate["kind"]) {
  return candidates.filter(
    (candidate): candidate is StackFrameCandidate =>
      candidate.kind === kind && isStackFrame(candidate)
  );
}

async function resolveObservation(
  job: ReactJob,
  observation: SelectionObservation
): Promise<ResolutionResult[]> {
  const answered = await resolveFrames(
    job,
    framesOf(observation.sourceCandidates, "element-creation"),
    { kind: "element", tagName: observation.tagName }
  );
  // Innermost first, the chain's own order, so a budget runs out on the outer components.
  for (const record of observation.componentChain.components) {
    const invocations = await resolveFrames(
      job,
      framesOf(record.sourceCandidates, "component-invocation"),
      { kind: "component" }
    );
    for (const [id, result] of invocations) answered.set(id, result);
    for (const candidate of framesOf(record.sourceCandidates, "component-definition")) {
      answered.set(candidate.candidateId, await resolveDefinition(job, candidate));
    }
  }
  return [
    ...observation.sourceCandidates,
    ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
  ].map(
    (candidate) =>
      answered.get(candidate.candidateId) ?? unavailableResult(candidate, "unsupported")
  );
}
