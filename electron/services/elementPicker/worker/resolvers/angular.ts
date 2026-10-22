import type { SourceLocation } from "../../../../../shared/elementPicker/coordinates.js";
import type { ComponentRecord } from "../../../../../shared/elementPicker/component.js";
import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
  SourceFileRef,
  UnavailableReason,
} from "../../../../../shared/elementPicker/resolution.js";
import type {
  HostSourceResolver,
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
  SourceAccessResult,
} from "../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../outcomes.js";

/**
 * The Angular resolver: what an Angular dev build reported about a selection,
 * checked against the files it names. What it reads in a request, as the
 * Angular extractor reports it:
 *
 * - A component record's `file-hint` from `ɵcmp.debugInfo.filePath`: answered
 *   `verified` once the file declares, in code, a class by the name the
 *   compiler recorded beside it (`ɵcmp.debugInfo.className`), and `mismatch`
 *   when it was read and declares none. A file and nothing finer, whatever line
 *   the compiler gave: a hint never gains a position.
 * - A `template-location` or `component-invocation` from the opt-in
 *   `data-ng-source-location` stamp: answered `verified` once a tag opens at
 *   exactly the stamped line and column, and for the element's own stamp once
 *   that tag is the element's and the stamped character offset lands there too.
 *
 * Anything else is `unsupported`. Paths are relative to the root the compiler
 * ran in, which `ng serve` makes the Angular workspace; main locates them
 * against the app root, so nothing here knows where either root is.
 */
export const angularResolver: HostSourceResolver = {
  framework: "angular",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const job = new AngularJob(request, access, signal);
    const outcomes: ResolveResponse["outcomes"] = [];
    // One observation at a time: a chain's records share their files, and one
    // read of each serves every candidate in it.
    for (const observation of request.observations) {
      outcomes.push({
        elementId: observation.elementId,
        results: await resolveObservation(job, observation),
      });
    }
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};

/** Where the extractor names the compiled class, which is the name a declaration has to carry. */
const CLASS_NAME_FIELD = "constructor.ɵcmp.debugInfo.className";

async function resolveObservation(
  job: AngularJob,
  observation: SelectionObservation
): Promise<ResolutionResult[]> {
  // Work not begun when the job was withdrawn is `cancelled`, even where the
  // bytes it needs were already read: an answer is what the job finished.
  const unlessCancelled = (
    candidate: SourceCandidate,
    work: () => Promise<ResolutionResult>
  ): Promise<ResolutionResult> =>
    job.cancelled ? Promise.resolve(unavailableResult(candidate, "cancelled")) : work();
  const results: ResolutionResult[] = [];
  for (const candidate of observation.sourceCandidates) {
    if (candidate.kind === "template-location" && candidate.location !== null) {
      const { location } = candidate;
      results.push(
        await unlessCancelled(candidate, () =>
          resolveStamp(job, candidate, location, {
            tagName: observation.tagName,
            offset: templateOffset(observation),
          })
        )
      );
    } else {
      results.push(unavailableResult(candidate, "unsupported"));
    }
  }
  for (const record of observation.componentChain.components) {
    for (const candidate of record.sourceCandidates) {
      if (candidate.kind === "component-invocation") {
        const { location } = candidate;
        results.push(
          await unlessCancelled(candidate, () =>
            resolveStamp(job, candidate, location, { tagName: null, offset: null })
          )
        );
      } else if (candidate.kind === "file-hint") {
        results.push(
          await unlessCancelled(candidate, () => resolveClassFile(job, candidate, record))
        );
      } else {
        results.push(unavailableResult(candidate, "unsupported"));
      }
    }
  }
  return results;
}

/** The character offset the element's own stamp carried, which the extractor keeps in its diagnostics. */
function templateOffset(observation: SelectionObservation): number | null {
  for (const entry of observation.frameworkEvidence) {
    if (entry.kind !== "generic" || entry.framework !== "angular") continue;
    const field = entry.fields.find((candidate) => candidate.name === "templateOffset");
    if (field !== undefined) return typeof field.value === "number" ? field.value : null;
  }
  return null;
}

/** A class's file, held to the class the compiler said is declared in it. */
async function resolveClassFile(
  job: AngularJob,
  candidate: SourceCandidate,
  record: ComponentRecord
): Promise<ResolutionResult> {
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const claimed = await job.readClaimed(candidate, located.value);
  if (!claimed.ok) return claimed.result;
  const source = claimed.source;
  const className =
    record.name?.extraction.kind === "runtime-field" &&
    record.name.extraction.field === CLASS_NAME_FIELD
      ? record.name.value
      : null;
  // A record named some other way gives the file nothing to be held to.
  if (className === null) {
    return {
      state: "observed",
      candidateId: candidate.candidateId,
      claim: candidate.kind,
      target: { file: source.file, location: null },
      fileRevision: source.revision,
    };
  }
  if (source.text === null) return unreadableResult(candidate, "unsupported", source);
  if (!job.declares(source, source.text, className)) {
    return unreadableResult(candidate, "mismatch", source);
  }
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: source.file, location: null },
    fileRevision: source.revision,
  };
}

/**
 * A stamped template position, proven rather than trusted: a tag must open at
 * exactly that line and column, never the nearest one. The stamp carries no
 * revision, so a page captured before an edit can land on some other tag in
 * the new bytes; the element's tag name and the stamped offset are the
 * independent witnesses the page gives for its own stamp.
 */
async function resolveStamp(
  job: AngularJob,
  candidate: SourceCandidate,
  location: SourceLocation,
  witness: { tagName: string | null; offset: number | null }
): Promise<ResolutionResult> {
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const claimed = await job.readClaimed(candidate, located.value);
  if (!claimed.ok) return claimed.result;
  const source = claimed.source;
  if (source.text === null) return unreadableResult(candidate, "unsupported", source);
  const text = source.text;
  const offset = offsetOf(
    text,
    location.line - location.lineBase,
    location.column - location.columnBase
  );
  const tag = offset === null ? null : tagAt(text, offset);
  const holds =
    tag !== null &&
    (witness.offset === null || witness.offset === offset) &&
    (witness.tagName === null || tag.toLowerCase() === witness.tagName.toLowerCase());
  if (!holds) return unreadableResult(candidate, "mismatch", source);
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: source.file, location },
    fileRevision: source.revision,
  };
}

/** The offset of a 0-based line and UTF-16 column, if the line is that long. */
function offsetOf(text: string, line: number, column: number): number | null {
  let start = 0;
  for (let at = 0; at < line; at += 1) {
    const next = text.indexOf("\n", start);
    if (next === -1) return null;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  const offset = start + column;
  return offset < (end === -1 ? text.length : end) ? offset : null;
}

/** An opening tag's name, ended where a real tag's name ends: not at a cut-off `<button` the file stops in. */
const OPENING_TAG = /^<([A-Za-z][\w.:-]*)(?=[\s/>])/;

/** Whether `offset` sits inside an HTML comment, where text that reads like a tag renders nothing. */
function inComment(text: string, offset: number): boolean {
  const open = text.lastIndexOf("<!--", offset);
  if (open === -1) return false;
  const close = text.indexOf("-->", open + 4);
  return close === -1 || close + 3 > offset;
}

/**
 * The name of the element a tag opening at `offset` renders, or null when no
 * tag opens there. Angular keeps a namespace apart from the name, so
 * `<svg:path>` renders a `path`.
 */
function tagAt(text: string, offset: number): string | null {
  const name = OPENING_TAG.exec(text.slice(offset, offset + 256))?.[1];
  if (name === undefined || inComment(text, offset)) return null;
  return name.slice(name.lastIndexOf(":") + 1);
}

const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && IDENTIFIER_PART.test(char);
}

/** Words after which an expression starts, so a `/` there opens a regular expression. */
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** Past a comment starting at `at`, or `at` itself when none does. */
function skipComment(text: string, at: number): number {
  if (text[at] !== "/") return at;
  if (text[at + 1] === "/") {
    const end = text.indexOf("\n", at);
    return end === -1 ? text.length : end + 1;
  }
  if (text[at + 1] === "*") {
    const end = text.indexOf("*/", at + 2);
    return end === -1 ? text.length : end + 2;
  }
  return at;
}

/** Past the whitespace and comments from `at`: what may sit between a keyword and its name. */
function skipTrivia(text: string, at: number): number {
  for (;;) {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
    const past = skipComment(text, at);
    if (past === at) return at;
    at = past;
  }
}

/** Past a string literal opening at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (char === quote || char === "\n") return at + 1;
  }
  return text.length;
}

/** Past a regular expression literal opening at `start`, a `/` inside a character class included. */
function skipRegExp(text: string, start: number): number {
  let inClass = false;
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (char === "\n") return at;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = at + 1;
      while (isIdentifierPart(text[end])) end += 1;
      return end;
    }
  }
  return text.length;
}

/**
 * Template literal text from `at` to the end of the literal or the start of a
 * substitution, whichever comes first.
 */
function scanTemplate(text: string, at: number): { end: number; substitution: boolean } {
  for (; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (char === "`") return { end: at + 1, substitution: false };
    else if (char === "$" && text[at + 1] === "{") return { end: at + 2, substitution: true };
  }
  return { end: text.length, substitution: false };
}

/**
 * Whether `text` declares a class named `name` in code: the `class` keyword,
 * then the name, with nothing but whitespace and comments between, outside
 * comments, strings, template literals and regular expressions. A scan rather
 * than a parse: a `/` is taken for a regular expression where an expression
 * may start, as a parser would, so a comment, a string, a pattern or an import
 * naming the class cannot stand in for its declaration.
 */
export function declaresClass(text: string, name: string): boolean {
  /** The brace depth each open template substitution began at, innermost last. */
  const substitutions: number[] = [];
  let depth = 0;
  /** Whether the last token ended a value, so a `/` after it divides. */
  let afterValue = false;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    const past = skipComment(text, at);
    if (past !== at) {
      at = past;
      continue;
    }
    if (/\s/.test(char)) {
      at += 1;
    } else if (char === '"' || char === "'") {
      at = skipString(text, at);
      afterValue = true;
    } else if (char === "`") {
      const scanned = scanTemplate(text, at + 1);
      at = scanned.end;
      if (scanned.substitution) {
        substitutions.push(depth);
        depth += 1;
        afterValue = false;
      } else {
        afterValue = true;
      }
    } else if (char === "/") {
      at = afterValue ? at + 1 : skipRegExp(text, at);
      afterValue = !afterValue;
    } else if (isIdentifierPart(char)) {
      let end = at;
      while (isIdentifierPart(text[end])) end += 1;
      const word = text.slice(at, end);
      if (word === "class") {
        const start = skipTrivia(text, end);
        let stop = start;
        while (isIdentifierPart(text[stop])) stop += 1;
        if (start > end && text.slice(start, stop) === name) return true;
      }
      at = end;
      afterValue = !EXPRESSION_KEYWORDS.has(word);
    } else if (char === "{") {
      depth += 1;
      at += 1;
      afterValue = false;
    } else if (char === "}") {
      depth -= 1;
      at += 1;
      // The brace that closes a substitution resumes the template it sits in.
      if (substitutions.length > 0 && substitutions[substitutions.length - 1] === depth) {
        substitutions.pop();
        const scanned = scanTemplate(text, at);
        at = scanned.end;
        if (scanned.substitution) {
          substitutions.push(depth);
          depth += 1;
          afterValue = false;
        } else {
          afterValue = true;
        }
      } else {
        afterValue = false;
      }
    } else {
      afterValue = char === ")" || char === "]";
      at += 1;
    }
  }
  return false;
}

interface ReadSource {
  file: SourceFileRef;
  /** Of the raw bytes, before decoding or BOM handling. */
  revision: FileRevision;
  /** Null when the bytes are not UTF-8. Never carries a leading BOM, which the compiler's offsets skip. */
  text: string | null;
}

type Read = { ok: true; source: ReadSource } | { ok: false; reason: UnavailableReason };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string | null {
  try {
    const text = decoder.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** One Angular resolve's view of the workspace: each path located and each file read at most once. */
class AngularJob {
  private readonly located = new Map<string, Promise<SourceAccessResult<SourceFileRef>>>();
  private readonly reads = new Map<string, Promise<Read>>();
  private readonly declarations = new Map<string, boolean>();
  private readonly known: Map<string, FileRevision>;

  constructor(
    request: ResolveRequest,
    private readonly access: ResolverSourceAccess,
    private readonly signal: AbortSignal
  ) {
    this.known = new Map(
      request.knownRevisions
        .filter((entry) => entry.file.workspaceId === request.workspaceId)
        .map((entry) => [entry.file.path, entry.revision])
    );
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  /** A recursive chain names one class on every record; its file is scanned for it once. */
  declares(source: ReadSource, text: string, className: string): boolean {
    const key = `${source.revision}\0${source.file.path}\0${className}`;
    let found = this.declarations.get(key);
    if (found === undefined) {
      found = declaresClass(text, className);
      this.declarations.set(key, found);
    }
    return found;
  }

  locate(reported: string): Promise<SourceAccessResult<SourceFileRef>> {
    let located = this.located.get(reported);
    if (!located) {
      located = this.access.locateFile(reported, this.signal);
      this.located.set(reported, located);
    }
    return located;
  }

  private read(file: SourceFileRef): Promise<Read> {
    let read = this.reads.get(file.path);
    if (!read) {
      read = this.access.readSource(file, this.signal).then((result): Read => {
        if (!result.ok) return result;
        const { revision, bytes } = result.value;
        return { ok: true, source: { file, revision, text: decode(bytes) } };
      });
      this.reads.set(file.path, read);
    }
    return read;
  }

  /**
   * The file a candidate claims, read and held to the revision an earlier
   * result pinned it at: `stale` when it changed or went away since, so a
   * changed file never quietly resolves somewhere new.
   */
  async readClaimed(
    candidate: SourceCandidate,
    file: SourceFileRef
  ): Promise<{ ok: true; source: ReadSource } | { ok: false; result: ResolutionResult }> {
    const read = await this.read(file);
    const known = this.known.get(file.path);
    if (!read.ok) {
      if (known !== undefined && read.reason === "file-missing") {
        return { ok: false, result: staleResult(candidate, file, known, null, "file-missing") };
      }
      return { ok: false, result: unavailableResult(candidate, read.reason) };
    }
    if (known !== undefined && known !== read.source.revision) {
      return {
        ok: false,
        result: staleResult(candidate, file, known, read.source.revision, "file-changed"),
      };
    }
    return read;
  }
}

function staleResult(
  candidate: SourceCandidate,
  file: SourceFileRef,
  known: FileRevision,
  current: FileRevision | null,
  reason: "file-changed" | "file-missing"
): ResolutionResult {
  return {
    state: "stale",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    held: {
      state: "observed",
      target: { file, location: candidate.kind === "file-hint" ? null : candidate.location },
      fileRevision: known,
    },
    currentFileRevision: current,
    reason,
  };
}

/** The file was read, and the claim cannot be held in it. */
function unreadableResult(
  candidate: SourceCandidate,
  reason: "mismatch" | "unsupported",
  source: ReadSource
): ResolutionResult {
  return {
    state: "unavailable",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    reason,
    read: { file: source.file, fileRevision: source.revision },
  };
}
