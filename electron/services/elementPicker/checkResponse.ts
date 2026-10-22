import {
  ResolveResponseSchema,
  type ResolveRequest,
  type ResolveResponse,
} from "../../../shared/elementPicker/resolver.js";
import type {
  FileRevision,
  HeldTarget,
  ResolutionResult,
  SourceFileRef,
} from "../../../shared/elementPicker/resolution.js";
import type { SourceClaimKind } from "../../../shared/elementPicker/source.js";
import { observationCandidates } from "./outcomes.js";
import { lexicalSourcePath, type SourceRoots } from "./sourceAccess.js";

/** What main knows about the job the response answers. */
export interface ResponseAuthority {
  roots: SourceRoots;
  /** The revision main served for a path in this job, if it served one. */
  servedRevision: (path: string) => FileRevision | undefined;
}

/** A file named with a revision: the revision must be one main served for it. */
interface NamedFile {
  file: SourceFileRef;
  revision: FileRevision | null;
}

function heldFile(target: HeldTarget): NamedFile {
  return { file: target.target.file, revision: target.fileRevision };
}

function namedFiles(result: ResolutionResult): NamedFile[] {
  switch (result.state) {
    case "observed":
    case "mapped":
    case "verified":
      return [heldFile(result)];
    case "ambiguous":
      return result.alternatives.map(heldFile);
    case "stale":
      // The held revision is what an earlier result read, so only the current one is this job's.
      return [{ file: result.held.target.file, revision: result.currentFileRevision }];
    case "unavailable":
      return result.read ? [{ file: result.read.file, revision: result.read.fileRevision }] : [];
  }
}

/**
 * The host's answer, if it answers this request. Well formed is not enough: it
 * must be for this request and epoch, speak only of the elements and
 * candidates the request carried, keep each candidate's claim, name files only
 * inside the request's own workspace and app, and claim only revisions main
 * actually served in this job. Anything else is a resolver bug, and none of it
 * is passed on.
 */
export function checkResolveResponse(
  request: ResolveRequest,
  raw: unknown,
  authority: ResponseAuthority
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
  const owned = ({ file, revision }: NamedFile) =>
    file.workspaceId === request.workspaceId &&
    lexicalSourcePath(authority.roots, file.path) !== null &&
    (revision === null || authority.servedRevision(file.path) === revision);

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
      if (!namedFiles(result).every(owned)) return null;
    }
  }
  return response;
}

/**
 * A job stopped by its deadline: whatever the host could not finish ran out of
 * budget, whichever word the resolver used for being stopped.
 */
export function relabelCancelled(response: ResolveResponse): ResolveResponse {
  return {
    ...response,
    outcomes: response.outcomes.map((outcome) => ({
      ...outcome,
      results: outcome.results.map((result) =>
        result.state === "unavailable" && result.reason === "cancelled"
          ? { ...result, reason: "budget-exhausted" }
          : result
      ),
    })),
  };
}
