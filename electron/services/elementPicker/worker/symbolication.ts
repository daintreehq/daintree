import type { TraceMap } from "@jridgewell/trace-mapping";
import type { ResolverSourceAccess } from "../../../../shared/elementPicker/resolver.js";
import {
  COORDINATE_CONVENTIONS,
  MAX_SOURCE_COORDINATE,
  type SourceLocation,
} from "../../../../shared/elementPicker/coordinates.js";
import type {
  FileRevision,
  ResolutionResult,
  SourceContentCheck,
  SourceFileRef,
  SourceMapProvenance,
  UnavailableReason,
} from "../../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../outcomes.js";

/**
 * Turns a position in a module the dev server served into the authored file
 * and line it came from, for the resolvers whose runtime reports generated
 * stack frames (React's `_debugStack`, and others like it). Everything it
 * needs comes through the job's source access: main fetches the map from the
 * preview's origin and says which workspace file a source names, and this
 * only parses the map and looks the position up.
 *
 * The decoder is imported the first time a frame is symbolicated, so a host
 * that never maps anything never loads it.
 */

/** A position in a generated module, as a runtime's stack reported it. */
export interface GeneratedFrame {
  url: string;
  location: SourceLocation;
}

export type Symbolication =
  | {
      ok: true;
      target: { file: SourceFileRef; location: SourceLocation };
      /** The identifier the map names at that position, if it names one. */
      name: string | null;
      /** The map marks the source as library code, as DevTools would hide it. */
      ignoreListed: boolean;
      sourceMap: SourceMapProvenance;
      /** What was on disk when the map's source was compared with it; null when it was not. */
      fileRevision: FileRevision | null;
    }
  | {
      ok: false;
      reason: UnavailableReason;
      /**
       * The file the frame is in even so, when the map does not place the
       * position but names that one source and nothing else, as a dev server's
       * map of one module does. Enough to say the file has changed since an
       * earlier result was pinned to it; never a position in it.
       */
      file?: SourceFileRef;
    };

/**
 * Turns generated frames into authored positions. A source map is one way to
 * do it; a dev server's own symbolication endpoint (#13885) is another.
 */
export interface FrameSymbolicator {
  symbolicate(frame: GeneratedFrame, signal: AbortSignal): Promise<Symbolication>;
}

type Decoder = typeof import("@jridgewell/trace-mapping");

/** One source a map names, kept by index: the decoder only ever sees an opaque id for it. */
interface MapSource {
  raw: string | null;
  sourceRoot: string | null;
  content: string | null;
  ignored: boolean;
}

interface DecodedMap {
  trace: TraceMap;
  sources: MapSource[];
  /** Roughly what holding it costs, which is what the cache is bounded by. */
  size: number;
}

/**
 * Past these a map is refused rather than decoded. Real dev-server maps are
 * nowhere near them; they bound what a map can make the host build.
 */
export const SOURCE_MAP_LIMITS = {
  sections: 4_096,
  sources: 16_384,
  /** Where a section may start: the decoder builds every generated line before it. */
  sectionLine: 1_000_000,
} as const;

/**
 * Decoded maps by the revision of their bytes. A revision is the map's
 * content, so an entry can never answer for a map that has since changed: an
 * HMR update that touches a module changes its map's bytes, and the map is
 * fetched again on every resolve, so the new bytes miss and the old entry is
 * only ever reached by a module still serving the old map.
 */
export const DECODED_MAP_CACHE_LIMITS = { entries: 32, size: 64 * 1024 * 1024 } as const;

/**
 * A decoded map is mostly arrays: one per generated line and one per segment,
 * each costing V8 tens of bytes before it holds anything. Charged by those
 * rather than by its text, since a map of a few bytes can decode to a million
 * empty lines.
 */
const LINE_COST = 40;
const SEGMENT_COST = 64;

function retainedSize(trace: Decoder, map: TraceMap, textLength: number): number {
  const lines = trace.decodedMappings(map);
  let segments = 0;
  for (const line of lines) segments += line.length;
  return textLength * 2 + lines.length * LINE_COST + segments * SEGMENT_COST;
}

const decodedMaps = new Map<FileRevision, DecodedMap>();
let decodedSize = 0;

function cached(revision: FileRevision): DecodedMap | undefined {
  const entry = decodedMaps.get(revision);
  if (entry) {
    decodedMaps.delete(revision);
    decodedMaps.set(revision, entry);
  }
  return entry;
}

function remember(revision: FileRevision, entry: DecodedMap): void {
  if (entry.size > DECODED_MAP_CACHE_LIMITS.size) return;
  // Two jobs can decode the same map at once; the second replaces the first.
  decodedSize -= decodedMaps.get(revision)?.size ?? 0;
  decodedMaps.set(revision, entry);
  decodedSize += entry.size;
  for (const [key, oldest] of decodedMaps) {
    if (
      decodedMaps.size <= DECODED_MAP_CACHE_LIMITS.entries &&
      decodedSize <= DECODED_MAP_CACHE_LIMITS.size
    ) {
      break;
    }
    decodedMaps.delete(key);
    decodedSize -= oldest.size;
  }
}

/** For tests: the decoded-map cache is process-wide. */
export function clearDecodedMapCache(): void {
  decodedMaps.clear();
  decodedSize = 0;
}

let decoder: Promise<Decoder> | null = null;

function loadDecoder(): Promise<Decoder> {
  decoder ??= import("@jridgewell/trace-mapping").catch((error: unknown) => {
    // Not cached: a transient failure must not disable mapping for the rest of the process.
    decoder = null;
    throw error;
  });
  return decoder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The map as the decoder will see it: each source swapped for an opaque id,
 * with what it named kept here by index. Left to the decoder, a source is
 * resolved as a URL, which rewrites a Windows or absolute path into a path on
 * the dev server, and is looked up by name, which confuses two sections that
 * both name `index.ts`.
 *
 * An index map is taken one level deep, as bundlers write them: each section
 * embeds a regular map. The pinned decoder places a nested section's columns
 * wrongly, and a section that points at a `url` would have the host fetch.
 */
function opaque(
  trace: Decoder,
  input: unknown
): { map: Record<string, unknown>; sources: MapSource[] } | null {
  if (!isRecord(input)) return null;
  const sources: MapSource[] = [];
  if (!("sections" in input)) {
    const map = opaqueLeaf(trace, input, sources);
    return map && { map, sources };
  }
  if (input.version !== 3 || !Array.isArray(input.sections)) return null;
  if (input.sections.length > SOURCE_MAP_LIMITS.sections) return null;
  const sections: Record<string, unknown>[] = [];
  for (const section of input.sections) {
    if (!isRecord(section) || "url" in section || !isRecord(section.offset)) return null;
    const { line, column } = section.offset;
    if (!isCoordinate(line) || !isCoordinate(column)) return null;
    if (line > SOURCE_MAP_LIMITS.sectionLine) return null;
    if (!isRecord(section.map) || "sections" in section.map) return null;
    const map = opaqueLeaf(trace, section.map, sources);
    if (!map) return null;
    sections.push({ offset: { line, column }, map });
  }
  return { map: { version: 3, sections }, sources };
}

/**
 * One regular map, decoded here so its segments can be checked against its
 * own sources: once sections are flattened, an index past the end of one
 * section's sources names a source in the next.
 */
function opaqueLeaf(
  trace: Decoder,
  input: Record<string, unknown>,
  sources: MapSource[]
): Record<string, unknown> | null {
  const { mappings, names, sourceRoot, sourcesContent } = input;
  if (input.version !== 3 || typeof mappings !== "string") return null;
  if (!Array.isArray(input.sources) || (names !== undefined && !Array.isArray(names))) return null;
  if (sources.length + input.sources.length > SOURCE_MAP_LIMITS.sources) return null;
  const ignoreList = Array.isArray(input.ignoreList)
    ? input.ignoreList
    : Array.isArray(input.x_google_ignoreList)
      ? input.x_google_ignoreList
      : [];
  const ignored = new Set(ignoreList.filter(isCoordinate));
  const root = typeof sourceRoot === "string" && sourceRoot !== "" ? sourceRoot : null;
  const ids = input.sources.map((source: unknown, index) => {
    const content = Array.isArray(sourcesContent) ? sourcesContent[index] : undefined;
    sources.push({
      raw: typeof source === "string" ? source : null,
      sourceRoot: root,
      content: typeof content === "string" ? content : null,
      ignored: ignored.has(index),
    });
    return String(sources.length - 1);
  });
  const leaf = { version: 3 as const, sources: ids, names: (names ?? []) as string[], mappings };
  const lines = trace.decodedMappings(new trace.TraceMap(leaf));
  for (const line of lines) {
    for (const segment of line) {
      if (segment.length > 1 && segment[1]! >= ids.length) return null;
    }
  }
  return { ...leaf, mappings: lines };
}

function decode(trace: Decoder, text: string): DecodedMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    const prepared = opaque(trace, parsed);
    if (!prepared) return null;
    const map = trace.AnyMap(prepared.map as Parameters<Decoder["AnyMap"]>[0]);
    return { trace: map, sources: prepared.sources, size: retainedSize(trace, map, text.length) };
  } catch {
    return null;
  }
}

/** A BOM is not content: a dev server may strip it before it builds the map, and the decoder strips the file's. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

type Unavailable = { ok: false; reason: UnavailableReason };

const unavailable = (reason: UnavailableReason): Unavailable => ({ ok: false, reason });

type LoadedMap =
  { ok: true; mapUrl: string | null; revision: FileRevision; decoded: DecodedMap } | Unavailable;

/** The file a source names, and whether the map's copy of it is what is on disk. */
type SourceVerdict =
  | {
      ok: true;
      file: SourceFileRef;
      sourceCheck: SourceContentCheck;
      fileRevision: FileRevision | null;
    }
  /** With the file when it was located and then could not be read. */
  | (Unavailable & { file?: SourceFileRef });

/**
 * One resolve's symbolicator. Every frame in one module shares one fetch of
 * its map, and every frame in one source one comparison with the file, within
 * the job; across jobs only the decoded maps are kept, and only by content.
 */
export function createSourceMapSymbolicator(access: ResolverSourceAccess): FrameSymbolicator {
  const maps = new Map<string, Promise<LoadedMap>>();
  const checks = new Map<string, Promise<SourceVerdict>>();
  const textDecoder = new TextDecoder();

  async function loadMap(url: string, signal: AbortSignal): Promise<LoadedMap> {
    const fetched = await access.fetchSourceMap(url, signal);
    if (!fetched.ok) return fetched;
    const { url: mapUrl, revision, text } = fetched.value;
    let decoded = cached(revision);
    if (!decoded) {
      const trace = await loadDecoder();
      if (signal.aborted) return unavailable("cancelled");
      // Another job may have decoded the same bytes while the decoder loaded.
      decoded = cached(revision);
      if (!decoded) {
        const fresh = decode(trace, text);
        if (!fresh) return unavailable("map-missing");
        remember(revision, fresh);
        decoded = fresh;
      }
    }
    return { ok: true, mapUrl, revision, decoded };
  }

  async function check(
    url: string,
    raw: string,
    source: MapSource,
    signal: AbortSignal
  ): Promise<SourceVerdict> {
    const located = await access.locateSource(
      { generatedUrl: url, source: raw, sourceRoot: source.sourceRoot },
      signal
    );
    if (!located.ok) return located;
    const file = located.value;
    if (source.content === null) {
      return { ok: true, file, sourceCheck: "unchecked", fileRevision: null };
    }
    const read = await access.readSource(file, signal);
    if (!read.ok) {
      // Out of budget is not a different file: the mapping stands, unchecked.
      if (read.reason === "budget-exhausted") {
        return { ok: true, file, sourceCheck: "unchecked", fileRevision: null };
      }
      return { ok: false, reason: read.reason, file };
    }
    const matches = withoutBom(textDecoder.decode(read.value.bytes)) === withoutBom(source.content);
    return {
      ok: true,
      file,
      sourceCheck: matches ? "matches" : "differs",
      fileRevision: read.value.revision,
    };
  }

  function checkOnce(
    loaded: Extract<LoadedMap, { ok: true }>,
    url: string,
    index: number,
    raw: string,
    source: MapSource,
    signal: AbortSignal
  ): Promise<SourceVerdict> {
    const key = `${loaded.revision}\n${url}\n${index}`;
    let checked = checks.get(key);
    if (!checked) {
      checked = check(url, raw, source, signal);
      checks.set(key, checked);
    }
    return checked;
  }

  /** A position the map leaves unplaced, attributed to its file when the map names only one. */
  async function unplaced(
    loaded: Extract<LoadedMap, { ok: true }>,
    url: string,
    signal: AbortSignal
  ): Promise<Symbolication> {
    const [only, ...rest] = loaded.decoded.sources;
    if (!only || rest.length > 0 || only.raw === null) return unavailable("map-missing");
    const { file } = await checkOnce(loaded, url, 0, only.raw, only, signal);
    return file ? { ok: false, reason: "map-missing", file } : unavailable("map-missing");
  }

  return {
    async symbolicate(frame, signal): Promise<Symbolication> {
      const { location } = frame;
      // The decoder's convention: 1-based lines, 0-based columns.
      const line = location.line - location.lineBase + 1;
      const column = location.column - location.columnBase;
      if (line < 1 || column < 0) return unavailable("map-missing");

      let map = maps.get(frame.url);
      if (!map) {
        map = loadMap(frame.url, signal);
        maps.set(frame.url, map);
      }
      const loaded = await map;
      if (!loaded.ok) return loaded;

      const trace = await loadDecoder();
      let found: ReturnType<Decoder["originalPositionFor"]>;
      try {
        found = trace.originalPositionFor(loaded.decoded.trace, { line, column });
      } catch {
        return unavailable("map-missing");
      }
      if (found.source === null || found.line === null || found.column === null) {
        return unplaced(loaded, frame.url, signal);
      }
      const index = Number(found.source);
      const source = loaded.decoded.sources[index];
      if (!source || source.raw === null) return unavailable("map-missing");
      // A map can encode a position before the start of its source; that is no position at all.
      if (
        found.line < 1 ||
        found.column < 0 ||
        found.line > MAX_SOURCE_COORDINATE ||
        found.column > MAX_SOURCE_COORDINATE
      ) {
        return unavailable("map-missing");
      }

      const verdict = await checkOnce(loaded, frame.url, index, source.raw, source, signal);
      if (!verdict.ok) return verdict;

      return {
        ok: true,
        target: {
          file: verdict.file,
          location: {
            ...COORDINATE_CONVENTIONS.sourceMap,
            columnUnit: "utf16",
            line: found.line,
            column: found.column,
          },
        },
        name: typeof found.name === "string" ? found.name : null,
        ignoreListed: source.ignored,
        sourceMap: {
          mapUrl: loaded.mapUrl,
          mapRevision: loaded.revision,
          sourceCheck: verdict.sourceCheck,
        },
        fileRevision: verdict.fileRevision,
      };
    },
  };
}

type PositionedCandidate = Exclude<SourceCandidate, { kind: "file-hint" }>;

/**
 * A candidate's result from its frame's symbolication. A map built from a
 * file that has changed on disk since is `stale`, never `mapped`: the line it
 * names was right for a file that is no longer there. Mapping is all this
 * says; a resolver that checks the claim at that line is what makes it
 * `verified`.
 */
export function symbolicatedResult(
  candidate: PositionedCandidate,
  symbolication: Symbolication
): ResolutionResult {
  if (!symbolication.ok) return unavailableResult(candidate, symbolication.reason);
  const { target, sourceMap, fileRevision } = symbolication;
  const claim = { candidateId: candidate.candidateId, claim: candidate.kind };
  if (sourceMap.sourceCheck === "differs") {
    return {
      state: "stale",
      ...claim,
      held: { state: "mapped", target, fileRevision: null, sourceMap },
      currentFileRevision: fileRevision,
      reason: "file-changed",
    };
  }
  return { state: "mapped", ...claim, target, fileRevision, sourceMap };
}
