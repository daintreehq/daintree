import type { Tree } from "@lezer/common";
import type {
  FileRevision,
  ResolutionResult,
  SourceFileRef,
  UnavailableReason,
} from "../../../../../../shared/elementPicker/resolution.js";
import type {
  ResolveRequest,
  ResolverSourceAccess,
  SourceAccessResult,
} from "../../../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../../outcomes.js";
import { SourceText, parse, type Dialect } from "./jsx.js";

/**
 * One Preact resolve's view of the workspace: every path located, every file
 * read and every source parsed at most once, so two candidates in one file
 * are checked against the same bytes and cite the same revision.
 */

/** One file as this job read it. */
export interface ReadSource {
  file: SourceFileRef;
  /** Of the raw bytes, before decoding or BOM handling. */
  revision: FileRevision;
  /**
   * Null when the bytes are not UTF-8. Never carries a leading BOM: the
   * transforms that number a file's lines and columns drop one first.
   */
  text: SourceText | null;
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

export class PreactJob {
  private readonly located = new Map<string, Promise<SourceAccessResult<SourceFileRef>>>();
  private readonly reads = new Map<string, Promise<Read>>();
  private readonly trees = new Map<string, Tree>();
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
        const text = decode(bytes);
        return {
          ok: true,
          source: { file, revision, text: text === null ? null : new SourceText(text) },
        };
      });
      this.reads.set(file.path, read);
    }
    return read;
  }

  /** A file's parse in `dialect`, made once per file in this job. */
  tree(file: SourceFileRef, text: SourceText, dialect: Dialect): Tree {
    const key = `${dialect}\n${file.path}`;
    let tree = this.trees.get(key);
    if (tree === undefined) {
      tree = parse(text.text, dialect);
      this.trees.set(key, tree);
    }
    return tree;
  }

  /**
   * The file a candidate claims, read and held to the revision an earlier
   * result pinned it at. Anything short of a readable file at that revision is
   * the candidate's whole answer: a refusal, or `stale` when the file changed
   * or went away since, so a changed file never quietly resolves somewhere new.
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

/**
 * What a claim held, as far as the request says: the file at the revision it
 * was pinned to. How far the earlier result got with it is the caller's to
 * keep; the request carries neither.
 */
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
