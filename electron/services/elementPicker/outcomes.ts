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

/** The request as the resolvers for `owns` see it: only the candidates they own, and only observations with one. */
export function requestFor(
  request: ResolveRequest,
  owns: (candidate: SourceCandidate) => boolean
): ResolveRequest {
  const observations: SelectionObservation[] = [];
  for (const observation of request.observations) {
    if (!observationCandidates(observation).some(owns)) continue;
    observations.push({
      ...observation,
      sourceCandidates: observation.sourceCandidates.filter(owns),
      componentChain: {
        ...observation.componentChain,
        components: observation.componentChain.components.map((record) => ({
          ...record,
          sourceCandidates: record.sourceCandidates.filter(owns),
        })),
      },
    });
  }
  return { ...request, observations };
}

/**
 * Answers every candidate of `request` in its own order: from the answer
 * `answerFor` names for it, or as `fallback` says when that answer is missing
 * or did not cover it.
 */
export function mergeAnswers(
  request: ResolveRequest,
  answerFor: (candidate: SourceCandidate) => ResolveResponse | null,
  fallback: (candidate: SourceCandidate) => ResolutionResult
): ResolveResponse {
  return {
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    outcomes: request.observations.map((observation) => ({
      elementId: observation.elementId,
      results: observationCandidates(observation).map(
        (candidate) =>
          answerFor(candidate)
            ?.outcomes.find((outcome) => outcome.elementId === observation.elementId)
            ?.results.find((result) => result.candidateId === candidate.candidateId) ??
          fallback(candidate)
      ),
    })),
  };
}
