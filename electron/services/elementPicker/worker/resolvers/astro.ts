import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
  SourceFileRef,
  SourceTarget,
} from "../../../../../shared/elementPicker/resolution.js";
import type {
  HostSourceResolver,
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
} from "../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import { observationCandidates, unavailableResult } from "../../outcomes.js";
import { checkAstroAnchor, lexiconOf, type Lexicon } from "./astroSource.js";

/**
 * Checks what Astro's compiler stamped on an element against the file it
 * names. Only the claims the Astro extractor makes are taken, each from the
 * element's own attributes or, once the dev toolbar has taken those off, its
 * counterpart's in the markup as served: a `template-location` from
 * `data-astro-source-loc` (1-based line and column, `astroSourceLoc` in
 * `COORDINATE_CONVENTIONS`) and a `file-hint` from `data-astro-source-file`.
 * Anything else, or one in another convention, is `unsupported` rather than
 * checked against the selected element's tag.
 *
 * A claim keeps the coordinates it was reported in; a check never moves it.
 * A file that changed since an earlier result read it comes back `stale`
 * before anything is checked in it, so a claim does not quietly verify
 * somewhere new.
 */

/**
 * Decoded and read through once per file per request, however many elements
 * it stamped; null when the bytes are not UTF-8, which nothing here can check.
 */
type Decoded = Map<string, { text: string; lexicon: Lexicon } | null>;

function decode(bytes: Uint8Array): { text: string; lexicon: Lexicon } | null {
  let text: string;
  try {
    // The mark is kept: whether the compiler counted it is the checker's question.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return { text, lexicon: lexiconOf(text) };
}

function isAstroClaim(candidate: SourceCandidate): boolean {
  if (candidate.extraction.kind !== "attribute") return false;
  if (candidate.kind === "file-hint") {
    return candidate.extraction.attribute === "data-astro-source-file";
  }
  return (
    candidate.kind === "template-location" &&
    candidate.extraction.attribute === "data-astro-source-loc" &&
    // Astro never sends a position-less template location: the stamp is the position.
    candidate.location !== null &&
    candidate.location.lineBase === 1 &&
    candidate.location.columnBase === 1 &&
    candidate.location.end === undefined
  );
}

async function resolveClaim(
  candidate: SourceCandidate,
  tagName: string,
  request: ResolveRequest,
  access: ResolverSourceAccess,
  signal: AbortSignal,
  decoded: Decoded
): Promise<ResolutionResult> {
  const claim = { candidateId: candidate.candidateId, claim: candidate.kind };
  const located = await access.locateFile(candidate.file, signal);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const file: SourceFileRef = located.value;
  const target: SourceTarget = {
    file,
    location: candidate.kind === "file-hint" ? null : candidate.location,
  };
  const known: FileRevision | undefined = request.knownRevisions.find(
    (entry) => entry.file.workspaceId === file.workspaceId && entry.file.path === file.path
  )?.revision;
  // What an earlier result held is not known to have been checked, only read.
  const held = (fileRevision: FileRevision) => ({
    state: "observed" as const,
    target,
    fileRevision,
  });

  const read = await access.readSource(file, signal);
  if (!read.ok) {
    if (read.reason === "file-missing" && known !== undefined) {
      return {
        state: "stale",
        ...claim,
        held: held(known),
        currentFileRevision: null,
        reason: "file-missing",
      };
    }
    return unavailableResult(candidate, read.reason);
  }
  const { revision, bytes } = read.value;
  if (known !== undefined && known !== revision) {
    return {
      state: "stale",
      ...claim,
      held: held(known),
      currentFileRevision: revision,
      reason: "file-changed",
    };
  }
  // The file is all a hint claims, and it was read.
  if (candidate.kind !== "template-location") {
    return { state: "verified", ...claim, target, fileRevision: revision };
  }

  const { location } = candidate;
  if (location === null) return unavailableResult(candidate, "unsupported");
  if (!decoded.has(file.path)) decoded.set(file.path, decode(bytes));
  const source = decoded.get(file.path) ?? null;
  const { line, column } = location;
  const check =
    source === null
      ? "inconclusive"
      : checkAstroAnchor(source.text, line, column, tagName, source.lexicon);
  switch (check) {
    case "verified":
      return { state: "verified", ...claim, target, fileRevision: revision };
    case "mismatch":
      return {
        state: "unavailable",
        ...claim,
        reason: "mismatch",
        read: { file, fileRevision: revision },
      };
    case "inconclusive":
      return { state: "observed", ...claim, target, fileRevision: revision };
  }
}

async function resolveObservation(
  observation: SelectionObservation,
  request: ResolveRequest,
  access: ResolverSourceAccess,
  signal: AbortSignal,
  decoded: Decoded
): Promise<ResolutionResult[]> {
  const own = new Set(observation.sourceCandidates);
  return Promise.all(
    observationCandidates(observation).map((candidate) =>
      // A component's claims are not the element's, so its tag says nothing about them.
      own.has(candidate) && isAstroClaim(candidate)
        ? resolveClaim(candidate, observation.tagName, request, access, signal, decoded)
        : Promise.resolve(unavailableResult(candidate, "unsupported"))
    )
  );
}

export const astroResolver: HostSourceResolver = {
  framework: "astro",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const decoded: Decoded = new Map();
    const outcomes = await Promise.all(
      request.observations.map(async (observation) => ({
        elementId: observation.elementId,
        results: await resolveObservation(observation, request, access, signal, decoded),
      }))
    );
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};
