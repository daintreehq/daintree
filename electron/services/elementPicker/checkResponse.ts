import {
  ResolveResponseSchema,
  type ResolveRequest,
  type ResolveResponse,
} from "../../../shared/elementPicker/resolver.js";
import type { ResolutionResult, SourceFileRef } from "../../../shared/elementPicker/resolution.js";
import type { SourceClaimKind } from "../../../shared/elementPicker/source.js";
import { observationCandidates } from "./outcomes.js";

function resultFiles(result: ResolutionResult): SourceFileRef[] {
  switch (result.state) {
    case "observed":
    case "mapped":
    case "verified":
      return [result.target.file];
    case "ambiguous":
      return result.alternatives.map((alternative) => alternative.target.file);
    case "stale":
      return [result.held.target.file];
    case "unavailable":
      return result.read ? [result.read.file] : [];
  }
}

/**
 * The host's answer, if it answers this request. Well formed is not enough: it
 * must be for this request and epoch, speak only of the elements and
 * candidates the request carried, keep each candidate's claim, and name files
 * only in the request's own workspace. Anything else is a resolver bug, and
 * none of it is passed on.
 */
export function checkResolveResponse(
  request: ResolveRequest,
  raw: unknown
): ResolveResponse | null {
  const parsed = ResolveResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const response = parsed.data;
  if (response.requestId !== request.requestId) return null;
  if (response.documentEpoch !== request.documentEpoch) return null;

  const claims = new Map<string, Map<string, SourceClaimKind>>(
    request.observations.map((observation) => [
      observation.elementId,
      new Map(
        observationCandidates(observation).map((candidate) => [
          candidate.candidateId,
          candidate.kind,
        ])
      ),
    ])
  );
  const answered = new Set<string>();
  for (const outcome of response.outcomes) {
    const candidates = claims.get(outcome.elementId);
    if (!candidates || answered.has(outcome.elementId)) return null;
    answered.add(outcome.elementId);
    const results = new Set<string>();
    for (const result of outcome.results) {
      if (candidates.get(result.candidateId) !== result.claim) return null;
      if (results.has(result.candidateId)) return null;
      results.add(result.candidateId);
      if (resultFiles(result).some((file) => file.workspaceId !== request.workspaceId)) {
        return null;
      }
    }
  }
  return response;
}
