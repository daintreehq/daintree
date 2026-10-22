import {
  RESOLUTION_LIMITS,
  type HeldTarget,
  type ResolutionResult,
} from "../../../../../../shared/elementPicker/resolution.js";
import type { SourceLocation } from "../../../../../../shared/elementPicker/coordinates.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../../outcomes.js";
import { symbolicatedResult, type Symbolication } from "../../symbolication.js";
import {
  pinnedStaleResult,
  unreadableResult,
  type ReactJob,
  type ReadSource,
  type StackFrameCandidate,
} from "./job.js";
import type { JsxElement, ParsedSource } from "./source.js";

type Mapped = Extract<Symbolication, { ok: true }>;

/**
 * What a group of frames from one `_debugStack` has to show for its claim:
 * for an element, a host element written with the tag the page reported; for
 * a component's call site, a component tag.
 */
export type JsxClaim = { kind: "element"; tagName: string } | { kind: "component" };

export function isStackFrame(candidate: SourceCandidate): candidate is StackFrameCandidate {
  return (
    candidate.extraction.kind === "generated-stack-frame" &&
    (candidate.kind === "element-creation" ||
      candidate.kind === "component-invocation" ||
      candidate.kind === "component-definition")
  );
}

function frameIndex(candidate: StackFrameCandidate): number {
  return candidate.extraction.kind === "generated-stack-frame"
    ? candidate.extraction.frameIndex
    : 0;
}

/** A path as the page or a map names it, with any query or fragment left off. */
function pathOf(reported: string): string {
  try {
    return new URL(reported).pathname;
  } catch {
    return reported.replace(/[?#].*$/, "");
  }
}

/**
 * Code nobody in the app wrote, by the URL the page ran it from: a dependency,
 * pre-bundled or not, or the dev server's own client and refresh runtime.
 * Known without fetching anything, which keeps a selection's few map fetches
 * for frames that could be the user's.
 */
export function isLibraryUrl(reported: string): boolean {
  const path = pathOf(reported);
  return (
    /(^|[\\/])node_modules[\\/]/.test(path) || (path.startsWith("/@") && !path.startsWith("/@fs/"))
  );
}

function isLibrary(mapped: Mapped): boolean {
  return mapped.ignoreListed || mapped.target.file.path.split("/").includes("node_modules");
}

/** A map's position as Babel numbers it: 1-based lines, 0-based columns. */
function positionOf(location: SourceLocation): { line: number; column: number } {
  return {
    line: location.line - location.lineBase + 1,
    column: location.column - location.columnBase,
  };
}

function heldOf(mapped: Mapped): HeldTarget {
  return {
    state: "mapped",
    target: mapped.target,
    fileRevision: mapped.fileRevision,
    sourceMap: mapped.sourceMap,
  };
}

/**
 * A frame the module's current map does not place. When the map still says
 * which file the module is, and an earlier result was pinned to a revision of
 * that file it no longer has, the page is running code from before an edit:
 * that is `stale`, not a gap in the map.
 */
async function unmappedResult(
  job: ReactJob,
  candidate: StackFrameCandidate,
  unmapped: Extract<Symbolication, { ok: false }>
): Promise<ResolutionResult> {
  const file = unmapped.file;
  const known = file === undefined ? undefined : job.knownRevision(file);
  if (file === undefined || known === undefined) {
    return unavailableResult(candidate, unmapped.reason);
  }
  const read = await job.read(file);
  if (!read.ok) {
    return read.reason === "file-missing"
      ? pinnedStaleResult(candidate, file, known, null, "file-missing")
      : unavailableResult(candidate, unmapped.reason);
  }
  return read.source.revision === known
    ? unavailableResult(candidate, unmapped.reason)
    : pinnedStaleResult(candidate, file, known, read.source.revision, "file-changed");
}

type Checked =
  | { ok: true; source: ReadSource & { text: string }; parsed: ParsedSource }
  | { ok: false; result: ResolutionResult };

/**
 * The authored file a frame mapped to, read and parsed, unless what was read
 * says the mapping no longer holds: a map built from other bytes than the
 * file's, or a file that changed or went away since an earlier result was
 * pinned to it, is `stale` rather than checked.
 */
async function checkMapped(
  job: ReactJob,
  candidate: StackFrameCandidate,
  mapped: Mapped
): Promise<Checked> {
  const fail = (result: ResolutionResult): Checked => ({ ok: false, result });
  if (mapped.sourceMap.sourceCheck === "differs") {
    return fail(symbolicatedResult(candidate, mapped));
  }
  const file = mapped.target.file;
  const known = job.knownRevision(file);
  const read = await job.read(file);
  if (!read.ok) {
    if (known !== undefined && read.reason === "file-missing") {
      return fail(pinnedStaleResult(candidate, file, known, null, "file-missing"));
    }
    // Mapped all the same: out of budget says nothing against the map.
    if (read.reason === "budget-exhausted") return fail(symbolicatedResult(candidate, mapped));
    return fail(unavailableResult(candidate, read.reason));
  }
  const source = read.source;
  if (known !== undefined && known !== source.revision) {
    return fail(pinnedStaleResult(candidate, file, known, source.revision, "file-changed"));
  }
  if (mapped.fileRevision !== null && mapped.fileRevision !== source.revision) {
    return fail({
      state: "stale",
      candidateId: candidate.candidateId,
      claim: candidate.kind,
      held: heldOf(mapped),
      currentFileRevision: source.revision,
      reason: "file-changed",
    });
  }
  const { text } = source;
  if (text === null) return fail(unreadableResult(candidate, "unsupported", source));
  const parsed = job.parse({ ...source, text });
  if (parsed === null) return fail(unreadableResult(candidate, "unsupported", source));
  return { ok: true, source: { ...source, text }, parsed };
}

function holds(element: JsxElement, claim: JsxClaim): boolean {
  return claim.kind === "element"
    ? element.intrinsic && element.name === claim.tagName
    : !element.intrinsic;
}

/**
 * One stack's frames, answered as one claim. React's factory frame is already
 * gone, so the first frame is whatever called it; frames from a dependency or
 * the dev server are passed over, since a library's own `jsx` wrapper sits
 * there too, and the first frame of the app's own code is the claim. That one
 * is `verified` when the file has a JSX element of the claimed kind starting
 * exactly where it maps; every frame after it is a caller, and none of them is
 * the claim. A frame that could not be mapped stops the walk: whether it was
 * the call is unknown, and a caller below it is not its stand-in.
 *
 * Where the first frame of the app's own code holds no JSX — a helper that
 * calls `createElement` or `jsx` for its caller — which frame wrote the
 * element is not something the stack says: the app's own frames from there
 * down are reported as the alternatives, and none is chosen.
 */
export async function resolveFrames(
  job: ReactJob,
  candidates: StackFrameCandidate[],
  claim: JsxClaim
): Promise<Map<string, ResolutionResult>> {
  const answers = new Map<string, ResolutionResult>();
  const ordered = [...candidates].sort((a, b) => frameIndex(a) - frameIndex(b));
  let settled = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index]!;
    if (job.cancelled) {
      answers.set(candidate.candidateId, unavailableResult(candidate, "cancelled"));
      continue;
    }
    if (settled || isLibraryUrl(candidate.file)) {
      answers.set(candidate.candidateId, unavailableResult(candidate, "unsupported"));
      continue;
    }
    const mapped = await job.symbolicate(candidate);
    if (!mapped.ok) {
      answers.set(candidate.candidateId, await unmappedResult(job, candidate, mapped));
      // Code outside the workspace is nobody's here to edit, so it is passed over like a library.
      if (mapped.reason !== "outside-workspace") settled = true;
      continue;
    }
    if (isLibrary(mapped)) {
      answers.set(candidate.candidateId, unavailableResult(candidate, "unsupported"));
      continue;
    }
    settled = true;
    const checked = await checkMapped(job, candidate, mapped);
    if (!checked.ok) {
      answers.set(candidate.candidateId, checked.result);
      continue;
    }
    const { source, parsed } = checked;
    const element = parsed.jsxAt(positionOf(mapped.target.location));
    if (element !== null) {
      answers.set(
        candidate.candidateId,
        holds(element, claim)
          ? {
              state: "verified",
              candidateId: candidate.candidateId,
              claim: candidate.kind,
              target: { file: source.file, location: element.location },
              fileRevision: source.revision,
              sourceMap: mapped.sourceMap,
            }
          : unreadableResult(candidate, "mismatch", source)
      );
      continue;
    }
    const alternatives = await callerTargets(job, ordered.slice(index + 1), mapped);
    answers.set(
      candidate.candidateId,
      alternatives.length >= 2
        ? {
            state: "ambiguous",
            candidateId: candidate.candidateId,
            claim: candidate.kind,
            alternatives,
          }
        : unreadableResult(candidate, "mismatch", source)
    );
  }
  return answers;
}

/** The first frame of the app's own code, then each of its callers that maps into the app, distinct. */
async function callerTargets(
  job: ReactJob,
  callers: StackFrameCandidate[],
  first: Mapped
): Promise<HeldTarget[]> {
  const targets = [heldOf(first)];
  const seen = new Set([JSON.stringify(first.target)]);
  for (const caller of callers) {
    if (targets.length >= RESOLUTION_LIMITS.alternatives || job.cancelled) break;
    if (isLibraryUrl(caller.file)) continue;
    const mapped = await job.symbolicate(caller);
    if (!mapped.ok || isLibrary(mapped) || mapped.sourceMap.sourceCheck === "differs") continue;
    const known = job.knownRevision(mapped.target.file);
    if (known !== undefined && known !== mapped.fileRevision) continue;
    const key = JSON.stringify(mapped.target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(heldOf(mapped));
  }
  return targets;
}

/**
 * Where a component is written: the frame React called it through, from an
 * element its own render made, mapped into the app and `verified` with the
 * declaration of the function whose body makes the call that frame stands at.
 * A frame at no call is from some other version of the file, and one in a
 * dependency is a library component, with nothing here to point at.
 */
export async function resolveDefinition(
  job: ReactJob,
  candidate: StackFrameCandidate
): Promise<ResolutionResult> {
  if (job.cancelled) return unavailableResult(candidate, "cancelled");
  if (isLibraryUrl(candidate.file)) return unavailableResult(candidate, "unsupported");
  const mapped = await job.symbolicate(candidate);
  if (!mapped.ok) return unmappedResult(job, candidate, mapped);
  if (isLibrary(mapped)) return unavailableResult(candidate, "unsupported");
  const checked = await checkMapped(job, candidate, mapped);
  if (!checked.ok) return checked.result;
  const location = checked.parsed.definitionAt(positionOf(mapped.target.location));
  if (location === null) return unreadableResult(candidate, "mismatch", checked.source);
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: checked.source.file, location },
    fileRevision: checked.source.revision,
    sourceMap: mapped.sourceMap,
  };
}
