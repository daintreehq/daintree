import { isGeneratedSourceFile, type SvelteParse } from "@daintreehq/svelte-source-model";
import type { SourceLocation } from "../../../../../../shared/elementPicker/coordinates.js";
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

/**
 * One Svelte resolve's view of the workspace: every path located, every file
 * read and every source parsed at most once, so two candidates in one file are
 * checked against the same bytes and cite the same revision.
 */

/** One file as this job read it. */
export interface ReadSource {
  file: SourceFileRef;
  /** Of the raw bytes, before decoding or BOM handling. */
  revision: FileRevision;
  /**
   * Null when the bytes are not UTF-8. Never carries a leading BOM: Svelte's
   * `parse` and `compile` strip one before assigning offsets, so every AST
   * range and every `__svelte_meta` position is measured without it.
   */
  text: string | null;
}

export type Read = { ok: true; source: ReadSource } | { ok: false; reason: UnavailableReason };

/** Reasons a read stops for that say nothing about the file, so nothing may be concluded from one. */
export function stoppedReason(reason: UnavailableReason): boolean {
  return reason === "cancelled" || reason === "budget-exhausted";
}

/**
 * `ignoreBOM` keeps a leading BOM as U+FEFF, as Svelte's Vite plugin reads a
 * file, so the offsets the dev runtime reports and the offsets parsed here
 * agree once one is stripped. `fatal` refuses bytes a decode would replace.
 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string | null {
  try {
    const text = decoder.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** A dev-runtime position: 1-based line, 0-based UTF-16 column. */
export interface MetaPosition {
  line: number;
  column: number;
}

/** A candidate's position in `__svelte_meta`'s own convention, whichever one it was reported in. */
export function metaPosition(location: SourceLocation): MetaPosition {
  return {
    line: location.line - location.lineBase + 1,
    column: location.column - location.columnBase,
  };
}

function positionAt(text: string, offset: number): MetaPosition {
  let line = 1;
  let lineStart = 0;
  for (
    let next = text.indexOf("\n");
    next !== -1 && next < offset;
    next = text.indexOf("\n", next + 1)
  ) {
    line += 1;
    lineStart = next + 1;
  }
  return { line, column: offset - lineStart };
}

/** A source range as a location in `__svelte_meta`'s convention, end exclusive. */
export function rangeLocation(text: string, start: number, end: number): SourceLocation {
  const from = positionAt(text, start);
  return {
    lineBase: 1,
    columnBase: 0,
    columnUnit: "utf16",
    line: from.line,
    column: from.column,
    end: positionAt(text, end),
  };
}

/**
 * SvelteKit's generated route shell and anything a dependency ships: real
 * ancestors of what the page shows, never the user's to edit. A string test,
 * so it runs on both spellings for a case-insensitive filesystem.
 */
export function isGenerated(...paths: string[]): boolean {
  return paths.some(
    (file) => isGeneratedSourceFile(file) || isGeneratedSourceFile(file.toLowerCase())
  );
}

export type LibDirectory =
  | { status: "found"; directory: string }
  | { status: "none" }
  | { status: "stopped"; reason: UnavailableReason };

const SVELTE_CONFIGS = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
  "svelte.config.cjs",
];

function dependsOnKit(manifest: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  return ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const dependencies = (parsed as Record<string, unknown>)[field];
    return (
      dependencies !== null &&
      typeof dependencies === "object" &&
      Object.hasOwn(dependencies, "@sveltejs/kit")
    );
  });
}

export class SvelteJob {
  private readonly located = new Map<string, Promise<SourceAccessResult<SourceFileRef>>>();
  private readonly reads = new Map<string, Promise<Read>>();
  private readonly known: Map<string, FileRevision>;
  private lib: Promise<LibDirectory> | null = null;
  readonly parse: SvelteParse;

  constructor(
    readonly request: ResolveRequest,
    private readonly access: ResolverSourceAccess,
    private readonly signal: AbortSignal,
    parse: SvelteParse
  ) {
    this.known = new Map(
      request.knownRevisions
        .filter((entry) => entry.file.workspaceId === request.workspaceId)
        .map((entry) => [entry.file.path, entry.revision])
    );
    // Resolving one node parses its file more than once (its location, then
    // its shape), and a selection repeats that across nodes and call sites.
    const parsed = new Map<string, { ast: ReturnType<SvelteParse> } | { error: unknown }>();
    this.parse = (text, options) => {
      let entry = parsed.get(text);
      if (!entry) {
        try {
          entry = { ast: parse(text, options) };
        } catch (error) {
          entry = { error };
        }
        parsed.set(text, entry);
      }
      if ("error" in entry) throw entry.error;
      return entry.ast;
    };
  }

  get workspaceId(): string {
    return this.request.workspaceId;
  }

  locate(reported: string): Promise<SourceAccessResult<SourceFileRef>> {
    let located = this.located.get(reported);
    if (!located) {
      located = this.access.locateFile(reported, this.signal);
      this.located.set(reported, located);
    }
    return located;
  }

  /** Whether two reported paths name the same file, which their spellings alone cannot say. */
  async sameFile(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const [left, right] = await Promise.all([this.locate(a), this.locate(b)]);
    return left.ok && right.ok && left.value.path === right.value.path;
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

  /**
   * Where `$lib` points. SvelteKit's is `src/lib` unless `kit.files.lib` says
   * otherwise, and that config is project code this never runs, so it is
   * followed only in an app that depends on SvelteKit and whose config never
   * mentions `files` at all, as a key, quoted, shorthand or spread. Every
   * file that could say otherwise must have been read or be absent: one
   * refused or undecodable proves nothing. A plain Svelte app's `$lib`, if it
   * has one, is a Vite alias this cannot see.
   */
  libDirectory(): Promise<LibDirectory> {
    this.lib ??= this.findLibDirectory();
    return this.lib;
  }

  private async findLibDirectory(): Promise<LibDirectory> {
    type Text =
      | { status: "text"; text: string }
      | { status: "absent" }
      | { status: "unreadable" }
      | { status: "stopped"; reason: UnavailableReason };
    const textOf = async (name: string): Promise<Text> => {
      const located = await this.locate(name);
      const read = located.ok ? await this.read(located.value) : located;
      if (read.ok) {
        return read.source.text === null
          ? { status: "unreadable" }
          : { status: "text", text: read.source.text };
      }
      if (stoppedReason(read.reason)) return { status: "stopped", reason: read.reason };
      return read.reason === "file-missing" ? { status: "absent" } : { status: "unreadable" };
    };
    const manifest = await textOf("package.json");
    if (manifest.status === "stopped") return manifest;
    if (manifest.status !== "text" || !dependsOnKit(manifest.text)) return { status: "none" };
    for (const name of SVELTE_CONFIGS) {
      const config = await textOf(name);
      if (config.status === "absent") continue;
      if (config.status === "stopped") return config;
      if (config.status === "unreadable" || /files/.test(config.text)) return { status: "none" };
    }
    return { status: "found", directory: "src/lib" };
  }

  /** The revision an earlier result held this file at, if the request carried one. */
  knownRevision(file: SourceFileRef): FileRevision | undefined {
    return this.known.get(file.path);
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
    const known = this.knownRevision(file);
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
 * was pinned to. How far the earlier result got with it, and any location it
 * found there, is the caller's to keep; the request carries neither.
 */
export function staleResult(
  candidate: SourceCandidate,
  file: SourceFileRef,
  known: FileRevision | null,
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
