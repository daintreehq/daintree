import type {
  FileRevision,
  ResolutionResult,
  SourceFileRef,
  UnavailableReason,
} from "../../../../../../shared/elementPicker/resolution.js";
import type {
  ResolveRequest,
  ResolverSourceAccess,
} from "../../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import {
  createSourceMapSymbolicator,
  type FrameSymbolicator,
  type Symbolication,
} from "../../symbolication.js";
import { parseSource, type ParsedSource } from "./source.js";

/**
 * One React resolve's view of the workspace: every module's map fetched,
 * every file read and every source parsed at most once, so frames in one file
 * are checked against the same bytes and cite the same revision.
 */

/** A `_debugStack` frame, the only kind of candidate React's extractor sends. */
export type StackFrameCandidate = Extract<
  SourceCandidate,
  { kind: "element-creation" | "component-invocation" | "component-definition" }
>;

export interface ReadSource {
  file: SourceFileRef;
  /** Of the raw bytes, before decoding or BOM handling. */
  revision: FileRevision;
  /** Null when the bytes are not UTF-8. Never carries a leading BOM. */
  text: string | null;
}

export type Read = { ok: true; source: ReadSource } | { ok: false; reason: UnavailableReason };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string | null {
  try {
    const text = decoder.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

export class ReactJob {
  private readonly symbolicator: FrameSymbolicator;
  private readonly reads = new Map<string, Promise<Read>>();
  private readonly parsed = new Map<string, ParsedSource | null>();
  private readonly known: Map<string, FileRevision>;

  constructor(
    readonly request: ResolveRequest,
    private readonly access: ResolverSourceAccess,
    private readonly signal: AbortSignal
  ) {
    this.symbolicator = createSourceMapSymbolicator(access);
    this.known = new Map(
      request.knownRevisions
        .filter((entry) => entry.file.workspaceId === request.workspaceId)
        .map((entry) => [entry.file.path, entry.revision])
    );
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  symbolicate(candidate: StackFrameCandidate): Promise<Symbolication> {
    return this.symbolicator.symbolicate(
      { url: candidate.file, location: candidate.location },
      this.signal
    );
  }

  read(file: SourceFileRef): Promise<Read> {
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

  /** Null for a file this resolver cannot parse, by its extension or its contents. */
  parse(source: ReadSource & { text: string }): ParsedSource | null {
    const key = `${source.revision}\n${source.file.path}`;
    if (!this.parsed.has(key)) this.parsed.set(key, parseSource(source.file.path, source.text));
    return this.parsed.get(key) ?? null;
  }

  /** The revision an earlier result held this file at, if the request carried one. */
  knownRevision(file: SourceFileRef): FileRevision | undefined {
    return this.known.get(file.path);
  }
}

/** The file was read, and the claim cannot be held in it. */
export function unreadableResult(
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

/**
 * A file an earlier result was pinned to that has since changed or gone. The
 * request carries the file and its old revision and nothing finer, and the
 * candidate's own position is in the generated module, not the file, so the
 * held target names no line: the caller keeps the one it was shown.
 */
export function pinnedStaleResult(
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
    held: { state: "observed", target: { file, location: null }, fileRevision: known },
    currentFileRevision: current,
    reason,
  };
}
