import type { ResolveRequest, ResolveResponse } from "../../../shared/elementPicker/resolver.js";
import type {
  ResolutionResult,
  UnavailableReason,
} from "../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../shared/elementPicker/source.js";
import type { SelectionObservation } from "../../../shared/elementPicker/observation.js";

/**
 * Shared by main and the host process, so it stays pure: types and plain
 * functions, nothing that touches a file or a process.
 */

/** Every candidate an observation carries, the element's own first, then each component's in chain order. */
export function observationCandidates(observation: SelectionObservation): SourceCandidate[] {
  return [
    ...observation.sourceCandidates,
    ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
  ];
}

export function unavailableResult(
  candidate: SourceCandidate,
  reason: UnavailableReason
): ResolutionResult {
  return {
    state: "unavailable",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    reason,
  };
}

/** A response that resolves nothing: what a request gets when it ran out of time or was withdrawn. */
export function unavailableResponse(
  request: ResolveRequest,
  reason: UnavailableReason
): ResolveResponse {
  return {
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    outcomes: request.observations.map((observation) => ({
      elementId: observation.elementId,
      results: observationCandidates(observation).map((candidate) =>
        unavailableResult(candidate, reason)
      ),
    })),
  };
}
