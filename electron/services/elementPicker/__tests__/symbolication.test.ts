import { AnyMap, TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE_CONVENTIONS,
  type SourceLocation,
} from "../../../../shared/elementPicker/coordinates.js";
import {
  ResolutionResultSchema,
  type SourceFileRef,
  type UnavailableReason,
} from "../../../../shared/elementPicker/resolution.js";
import type {
  MapSourceLocation,
  ResolverSourceAccess,
  SourceAccessResult,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { revisionOf } from "../sourceAccess.js";
import {
  SOURCE_MAP_LIMITS,
  clearDecodedMapCache,
  createSourceMapSymbolicator,
  mappingsExtent,
  symbolicatedResult,
} from "../worker/symbolication.js";

// Called through, so a test can tell whether a map was decoded at all.
vi.mock("@jridgewell/trace-mapping", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jridgewell/trace-mapping")>();
  return {
    ...actual,
    AnyMap: vi.fn(actual.AnyMap),
    decodedMappings: vi.fn(actual.decodedMappings),
  };
});

/** [generated column, source index, source line, source column, name index?], all 0-based. */
type Segment = [number, number, number, number] | [number, number, number, number, number];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** Encodes mappings by hand, so what a test expects never comes from the decoder it tests. */
function encode(lines: Segment[][]): string {
  const last = [0, 0, 0, 0];
  return lines
    .map((segments) => {
      let column = 0;
      return segments
        .map((segment) => {
          const fields = [vlq(segment[0] - column)];
          column = segment[0];
          for (let index = 1; index < segment.length; index++) {
            fields.push(vlq(segment[index]! - last[index - 1]!));
            last[index - 1] = segment[index]!;
          }
          return fields.join("");
        })
        .join(",");
    })
    .join(";");
}

const CARD = "export function Card() {\n  return <h2>title</h2>;\n}\n";
const LIST = "export function List() {\n  return <ul />;\n}\n";

/** The module line 2 calls jsx at column 9, which Card.tsx wrote at line 2 column 9. */
const cardMap = (overrides: Record<string, unknown> = {}) => ({
  version: 3,
  sources: ["Card.tsx"],
  names: ["jsx"],
  sourcesContent: [CARD],
  mappings: encode([
    [[0, 0, 0, 0]],
    [
      [2, 0, 1, 2],
      [9, 0, 1, 9, 0],
    ],
  ]),
  ...overrides,
});

const MODULE = "http://localhost:5173/src/Card.tsx?t=1";

interface Fake {
  access: ResolverSourceAccess;
  fetchSourceMap: ReturnType<typeof vi.fn>;
  locateSource: ReturnType<typeof vi.fn>;
  readSource: ReturnType<typeof vi.fn>;
}

function fake(
  map: unknown,
  options: {
    mapUrl?: string | null;
    disk?: Record<string, string>;
    read?: SourceAccessResult<never>;
    fetched?: SourceAccessResult<never>;
    located?: SourceAccessResult<never>;
  } = {}
): Fake {
  const text = typeof map === "string" ? map : JSON.stringify(map);
  const disk = options.disk ?? { "src/Card.tsx": CARD, "src/List.tsx": LIST };
  const fetchSourceMap = vi.fn(
    async () =>
      options.fetched ?? {
        ok: true as const,
        value: {
          url: options.mapUrl ?? null,
          revision: revisionOf(new TextEncoder().encode(text)),
          text,
        },
      }
  );
  const locateSource = vi.fn(
    async (location: MapSourceLocation): Promise<SourceAccessResult<SourceFileRef>> =>
      options.located ?? {
        ok: true,
        value: {
          workspaceId: "ws",
          path: `src/${(location.sourceRoot ?? "") + location.source}`.replace(/\/+/g, "/"),
        },
      }
  );
  const readSource = vi.fn(async (file: SourceFileRef) => {
    if (options.read) return options.read;
    const content = disk[file.path];
    if (content === undefined) return { ok: false as const, reason: "file-missing" as const };
    const bytes = new TextEncoder().encode(content);
    return { ok: true as const, value: { file, revision: revisionOf(bytes), bytes } };
  });
  // Symbolication never locates a page-reported path; only a map's sources.
  const locateFile = vi.fn(async (): Promise<SourceAccessResult<SourceFileRef>> => ({
    ok: false,
    reason: "outside-workspace",
  }));
  return {
    access: { fetchSourceMap, locateSource, locateFile, readSource } as ResolverSourceAccess,
    fetchSourceMap,
    locateSource,
    readSource,
  };
}

const v8 = (line: number, column: number): SourceLocation => ({
  ...COORDINATE_CONVENTIONS.v8StackFrame,
  columnUnit: "utf16",
  line,
  column,
});

const authored = (line: number, column: number) => ({
  ...COORDINATE_CONVENTIONS.sourceMap,
  columnUnit: "utf16",
  line,
  column,
});

const signal = new AbortController().signal;

function symbolicate(subject: Fake, location = v8(2, 10), url = MODULE) {
  return createSourceMapSymbolicator(subject.access).symbolicate({ url, location }, signal);
}

afterEach(() => {
  clearDecodedMapCache();
  vi.clearAllMocks();
});

describe("source map symbolication", () => {
  it("maps a V8 frame through an inline map to the authored line, and says it matched", async () => {
    const subject = fake(cardMap());
    const result = await symbolicate(subject);
    const cardRevision = revisionOf(new TextEncoder().encode(CARD));
    expect(result).toEqual({
      ok: true,
      target: { file: { workspaceId: "ws", path: "src/Card.tsx" }, location: authored(2, 9) },
      name: "jsx",
      ignoreListed: false,
      sourceMap: {
        mapUrl: null,
        mapRevision: revisionOf(new TextEncoder().encode(JSON.stringify(cardMap()))),
        sourceCheck: "matches",
      },
      fileRevision: cardRevision,
    });
    expect(subject.locateSource).toHaveBeenCalledWith(
      { generatedUrl: MODULE, source: "Card.tsx", sourceRoot: null },
      signal
    );
  });

  it("converts the frame's own convention, so one position maps the same either way", async () => {
    const zeroColumn: SourceLocation = {
      ...COORDINATE_CONVENTIONS.svelteMeta,
      columnUnit: "utf16",
      line: 2,
      column: 9,
    };
    const fromV8 = await symbolicate(fake(cardMap()), v8(2, 10));
    const fromZero = await symbolicate(fake(cardMap()), zeroColumn);
    expect(fromZero).toEqual(fromV8);
    // One column earlier is the segment before it.
    await expect(symbolicate(fake(cardMap()), v8(2, 9))).resolves.toMatchObject({
      target: { location: authored(2, 2) },
      name: null,
    });
  });

  it("names the external map a frame went through", async () => {
    const result = await symbolicate(
      fake(cardMap(), { mapUrl: "http://localhost:5173/assets/card.js.map" })
    );
    expect(result).toMatchObject({
      ok: true,
      sourceMap: { mapUrl: "http://localhost:5173/assets/card.js.map" },
    });
  });

  it("maps through a sectioned map, keeping same-named sources in different sections apart", async () => {
    const sectioned = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sourceRoot: "card/",
            sources: ["index.tsx"],
            sourcesContent: [CARD],
            names: [],
            mappings: encode([[[0, 0, 0, 0]], [[2, 0, 1, 9]]]),
          },
        },
        {
          offset: { line: 10, column: 0 },
          map: {
            version: 3,
            sourceRoot: "list/",
            sources: ["index.tsx"],
            sourcesContent: [LIST],
            names: [],
            mappings: encode([[[0, 0, 0, 0]], [[4, 0, 1, 2]]]),
          },
        },
      ],
    };
    const subject = fake(sectioned, {
      disk: { "src/card/index.tsx": CARD, "src/list/index.tsx": LIST },
    });
    const symbolicator = createSourceMapSymbolicator(subject.access);
    const inList = await symbolicator.symbolicate({ url: MODULE, location: v8(12, 5) }, signal);
    expect(inList).toMatchObject({
      ok: true,
      target: { file: { path: "src/list/index.tsx" }, location: authored(2, 2) },
      sourceMap: { sourceCheck: "matches" },
    });
    const inCard = await symbolicator.symbolicate({ url: MODULE, location: v8(2, 3) }, signal);
    expect(inCard).toMatchObject({
      ok: true,
      target: { file: { path: "src/card/index.tsx" }, location: authored(2, 9) },
      sourceMap: { sourceCheck: "matches" },
    });
    expect(subject.locateSource.mock.calls.map(([location]) => location)).toEqual([
      { generatedUrl: MODULE, source: "index.tsx", sourceRoot: "list/" },
      { generatedUrl: MODULE, source: "index.tsx", sourceRoot: "card/" },
    ]);
    // One map for the module, however many frames are in it.
    expect(subject.fetchSourceMap).toHaveBeenCalledTimes(1);
  });

  it("hands main the source exactly as the map names it, Windows paths and all", async () => {
    const subject = fake(cardMap({ sources: ["C:\\app\\src\\Card.tsx"], sourceRoot: "" }));
    await symbolicate(subject);
    expect(subject.locateSource).toHaveBeenCalledWith(
      { generatedUrl: MODULE, source: "C:\\app\\src\\Card.tsx", sourceRoot: null },
      signal
    );
  });

  it("reports a map built from a file that has since changed as stale, not mapped", async () => {
    const edited = "// edited\n" + CARD;
    const subject = fake(cardMap(), { disk: { "src/Card.tsx": edited } });
    const symbolication = await symbolicate(subject);
    const editedRevision = revisionOf(new TextEncoder().encode(edited));
    expect(symbolication).toMatchObject({
      ok: true,
      sourceMap: { sourceCheck: "differs" },
      fileRevision: editedRevision,
    });
    const result = symbolicatedResult(creation(), symbolication);
    expect(result).toMatchObject({
      state: "stale",
      reason: "file-changed",
      currentFileRevision: editedRevision,
      held: { state: "mapped", fileRevision: null, sourceMap: { sourceCheck: "differs" } },
    });
    expect(ResolutionResultSchema.safeParse(result).success).toBe(true);
  });

  it("ignores a BOM on either side and keeps line endings significant", async () => {
    await expect(
      symbolicate(fake(cardMap(), { disk: { "src/Card.tsx": `\uFEFF${CARD}` } }))
    ).resolves.toMatchObject({ sourceMap: { sourceCheck: "matches" } });
    await expect(
      symbolicate(fake(cardMap({ sourcesContent: [`\uFEFF${CARD}`] })))
    ).resolves.toMatchObject({ sourceMap: { sourceCheck: "matches" } });
    await expect(
      symbolicate(fake(cardMap(), { disk: { "src/Card.tsx": CARD.replace(/\n/g, "\r\n") } }))
    ).resolves.toMatchObject({ sourceMap: { sourceCheck: "differs" } });
  });

  it("leaves the source unchecked, and unread, when the map embeds none of it", async () => {
    const subject = fake(cardMap({ sourcesContent: undefined }));
    await expect(symbolicate(subject)).resolves.toMatchObject({
      ok: true,
      sourceMap: { sourceCheck: "unchecked" },
      fileRevision: null,
    });
    expect(subject.readSource).not.toHaveBeenCalled();
  });

  it("keeps the mapping unchecked when the read is out of budget, and drops it when the file is gone", async () => {
    await expect(
      symbolicate(fake(cardMap(), { read: { ok: false, reason: "budget-exhausted" } }))
    ).resolves.toMatchObject({ ok: true, sourceMap: { sourceCheck: "unchecked" } });
    // Gone, or refused, but still the file the frame is in: an earlier result pinned to it can say so.
    const card = { workspaceId: "ws", path: "src/Card.tsx" };
    await expect(symbolicate(fake(cardMap(), { disk: {} }))).resolves.toEqual({
      ok: false,
      reason: "file-missing",
      file: card,
    });
    for (const reason of ["outside-workspace", "unsupported", "cancelled"] as const) {
      await expect(
        symbolicate(fake(cardMap(), { read: { ok: false, reason } })),
        reason
      ).resolves.toEqual({ ok: false, reason, file: card });
    }
  });

  it("passes on why main would not fetch or locate", async () => {
    for (const reason of ["outside-workspace", "budget-exhausted", "map-missing", "unsupported"]) {
      await expect(
        symbolicate(
          fake(cardMap(), { fetched: { ok: false, reason: reason as UnavailableReason } })
        )
      ).resolves.toEqual({ ok: false, reason });
    }
    await expect(
      symbolicate(fake(cardMap(), { located: { ok: false, reason: "unsupported" } }))
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports a position the map does not cover as map-missing", async () => {
    // Past the last line, and a segment that names no source. A map of one
    // source still says which file the frame is in, though not where.
    const card = { workspaceId: "ws", path: "src/Card.tsx" };
    await expect(symbolicate(fake(cardMap()), v8(40, 1))).resolves.toEqual({
      ok: false,
      reason: "map-missing",
      file: card,
    });
    const sourceless = cardMap({ mappings: "A;AAAA" });
    await expect(symbolicate(fake(sourceless), v8(1, 1))).resolves.toEqual({
      ok: false,
      reason: "map-missing",
      file: card,
    });
    await expect(symbolicate(fake(cardMap({ sources: [null] })))).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
    // With two sources, an unplaced position could be in either.
    const bundled = cardMap({ sources: ["Card.tsx", "List.tsx"], sourcesContent: [CARD, LIST] });
    await expect(symbolicate(fake(bundled), v8(40, 1))).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
  });

  it("refuses a mapping to before the start of its source rather than naming line 0", async () => {
    // Source line -1 and source column -1: decodable, but no position in any file.
    for (const mappings of ["AADA", "AAAD"]) {
      await expect(symbolicate(fake(cardMap({ mappings })), v8(1, 1)), mappings).resolves.toEqual({
        ok: false,
        reason: "map-missing",
      });
    }
  });

  it("names nothing when the map's name at that position is not a string", async () => {
    await expect(symbolicate(fake(cardMap({ names: [42] })))).resolves.toMatchObject({
      ok: true,
      name: null,
    });
  });

  it("refuses a map it cannot or should not decode", async () => {
    const section = (map: unknown, line = 0) => ({
      version: 3,
      sections: [{ offset: { line, column: 0 }, map }],
    });
    for (const map of [
      "{ not json",
      cardMap({ version: 2 }),
      cardMap({ mappings: 42 }),
      { version: 3, sections: [{ offset: { line: 0, column: 0 }, url: "http://localhost/x.map" }] },
      { version: 3, sections: [{ offset: { line: -1, column: 0 }, map: cardMap() }] },
      // Nested sections: the pinned decoder misplaces their columns.
      section(section(cardMap())),
      cardMap({ sources: Array.from({ length: SOURCE_MAP_LIMITS.sources + 1 }, () => "a.ts") }),
    ]) {
      await expect(symbolicate(fake(map))).resolves.toEqual({ ok: false, reason: "map-missing" });
    }
    await expect(symbolicate(fake(section(cardMap())))).resolves.toMatchObject({ ok: true });
  });

  it("refuses a map that would decode past its limits, before decoding any of it", async () => {
    const { lines, segments } = SOURCE_MAP_LIMITS;
    const card = cardMap().mappings;
    const dense = (count: number) => "AAAA" + ",C".repeat(count - 1);
    const sectioned = (...parts: [line: number, mappings: string][]) => ({
      version: 3,
      sections: parts.map(([line, mappings]) => ({
        offset: { line, column: 0 },
        map: cardMap({ mappings }),
      })),
    });
    for (const map of [
      // A line too many, out of nothing but separators.
      cardMap({ mappings: card + ";".repeat(lines - 1) }),
      cardMap({ mappings: dense(segments + 1) }),
      // As many with no comma between them: the decoder ends each after its fifth field.
      cardMap({ mappings: "AAAAAA".repeat(segments + 1) }),
      // The decoder builds every line before a section's offset.
      sectioned([lines - 1, card]),
      sectioned([1_000_000_000, card]),
      // Inside the limits apart, past them together.
      sectioned([0, dense(segments / 2 + 1)], [1, dense(segments / 2)]),
      // Overlapping sections: each is decoded whole before the next cuts it short.
      sectioned([0, card + ";".repeat(lines / 2)], [1, card + ";".repeat(lines / 2)]),
      // At both limits at once, which is more than the cache would hold.
      cardMap({ mappings: dense(segments) + ";".repeat(lines - 1) }),
    ]) {
      const subject = fake(map);
      await expect(symbolicate(subject)).resolves.toEqual({
        ok: false,
        reason: "budget-exhausted",
      });
      expect(decodedMappings).not.toHaveBeenCalled();
      expect(AnyMap).not.toHaveBeenCalled();
      expect(subject.locateSource).not.toHaveBeenCalled();
    }
  });

  it("decodes a map right up to each limit", async () => {
    const { lines, segments } = SOURCE_MAP_LIMITS;
    // Generated-only segments after the last mapped one, one column apart.
    for (const mappings of [
      cardMap().mappings + ";".repeat(lines - 2),
      cardMap().mappings + ",C".repeat(segments - 3),
    ]) {
      await expect(symbolicate(fake(cardMap({ mappings })))).resolves.toMatchObject({
        ok: true,
        target: { location: authored(2, 9) },
      });
    }
    expect(decodedMappings).toHaveBeenCalled();
  });

  it("counts the lines and segments the decoder builds, however the mappings are written", () => {
    for (const mappings of [
      "",
      ";;",
      ",",
      ",,,",
      "A,,A",
      "A,,,,,,B",
      "AAAA,",
      "AAAA;AACA,EAAE",
      "A".repeat(30),
      "AAAAAgB",
      "gggg",
      // A field still continuing at a line's end reads into the next.
      "AAAAg;A",
      "Ag",
      "é,A;~",
      cardMap().mappings,
    ]) {
      const decoded = decodedMappings(
        new TraceMap({ version: 3, sources: [], names: [], mappings })
      );
      expect(mappingsExtent(mappings)).toEqual({
        lines: decoded.length,
        segments: decoded.flat().length,
      });
    }
  });

  it("never lets one section's bad source index name a source in the next", async () => {
    const leaf = (source: string, mappings: string) => ({
      version: 3,
      sources: [source],
      names: [],
      mappings,
    });
    const sectioned = {
      version: 3,
      sections: [
        // "ACAA" points at source 1, which this section does not have.
        { offset: { line: 0, column: 0 }, map: leaf("a.ts", "ACAA") },
        { offset: { line: 1, column: 0 }, map: leaf("b.ts", "AAAA") },
      ],
    };
    await expect(symbolicate(fake(sectioned), v8(1, 1))).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
  });

  it("charges the cache for what a map decodes to, not its text", async () => {
    // A few bytes that decode to most of a million empty lines. Either can be
    // held but not both, so the first is decoded again rather than reused.
    const line = SOURCE_MAP_LIMITS.lines - 100_000;
    const phantom = (tag: string) => ({
      version: 3,
      tag,
      sections: [{ offset: { line, column: 0 }, map: cardMap() }],
    });
    const at = v8(line + 2, 10);
    const first = phantom("a");
    const replay = () => {
      const subject = fake(first);
      subject.fetchSourceMap.mockResolvedValue({
        ok: true,
        value: {
          url: null,
          revision: revisionOf(new TextEncoder().encode(JSON.stringify(first))),
          text: "{ not json",
        },
      });
      return subject;
    };
    await expect(symbolicate(fake(first), at)).resolves.toMatchObject({ ok: true });
    await expect(symbolicate(replay(), at)).resolves.toMatchObject({ ok: true });
    await expect(symbolicate(fake(phantom("b")), at)).resolves.toMatchObject({ ok: true });
    await expect(symbolicate(replay(), at)).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
  });

  it("marks a source the map ignore-lists", async () => {
    await expect(symbolicate(fake(cardMap({ x_google_ignoreList: [0] })))).resolves.toMatchObject({
      ok: true,
      ignoreListed: true,
    });
    await expect(symbolicate(fake(cardMap({ ignoreList: [0] })))).resolves.toMatchObject({
      ignoreListed: true,
    });
  });

  it("reuses a decoded map only for the same bytes, so an HMR update is never answered from the old one", async () => {
    const before = cardMap();
    const after = cardMap({ mappings: encode([[[0, 0, 0, 0]], [[9, 0, 6, 4]]]) });
    await expect(symbolicate(fake(before))).resolves.toMatchObject({
      target: { location: authored(2, 9) },
    });
    // The module was updated: new bytes, new revision, a new mapping.
    await expect(symbolicate(fake(after))).resolves.toMatchObject({
      target: { location: authored(7, 4) },
    });
    // The same revision again is the same map, whatever text arrives with it.
    const replay = fake(before);
    const revision = revisionOf(new TextEncoder().encode(JSON.stringify(before)));
    replay.fetchSourceMap.mockResolvedValue({
      ok: true,
      value: { url: null, revision, text: "{ not json" },
    });
    await expect(symbolicate(replay)).resolves.toMatchObject({
      ok: true,
      target: { location: authored(2, 9) },
    });
  });
});

function creation(): Extract<SourceCandidate, { kind: "element-creation" }> {
  return {
    kind: "element-creation",
    candidateId: "c-1",
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 1 },
    file: MODULE,
    location: v8(2, 10),
  };
}

describe("a module asked for by more than one name", () => {
  const SERVER = "about://React/Server/file:///work/app/.next/server/page.js";
  const DISK = "file:///work/app/.next/server/page.js";

  const answer = (text: string) => ({
    ok: true as const,
    value: { url: null, revision: revisionOf(new TextEncoder().encode(text)), text },
  });

  function trying(first: SourceAccessResult<never> | "undecodable" | "oversized") {
    const subject = fake(cardMap());
    subject.fetchSourceMap.mockImplementation(async (url: string) => {
      if (url !== SERVER) return answer(JSON.stringify(cardMap()));
      if (first === "undecodable") return answer("<!doctype html>");
      if (first === "oversized") {
        return answer(JSON.stringify(cardMap({ mappings: ";".repeat(SOURCE_MAP_LIMITS.lines) })));
      }
      return first;
    });
    return subject;
  }

  const symbolicateFrom = (subject: Fake) =>
    createSourceMapSymbolicator(subject.access).symbolicate(
      { url: SERVER, alternates: [DISK], location: v8(2, 10) },
      signal
    );

  it("takes the next name's map when one has none, or none that decodes, and locates from that one", async () => {
    for (const first of [
      { ok: false, reason: "unsupported" } as const,
      { ok: false, reason: "map-missing" } as const,
      "undecodable" as const,
    ]) {
      clearDecodedMapCache();
      const subject = trying(first);
      const result = await symbolicateFrom(subject);
      expect(result.ok && result.target.location).toEqual(authored(2, 9));
      expect(subject.fetchSourceMap.mock.calls.map(([url]) => url)).toEqual([SERVER, DISK]);
      expect(subject.locateSource.mock.calls.map(([location]) => location.generatedUrl)).toEqual([
        DISK,
      ]);
    }
  });

  it("asks the next name when one ran out of budget, which main holds each kind of read to", async () => {
    // Out of the job's network or reads, or a map too large to decode.
    for (const first of [
      { ok: false, reason: "budget-exhausted" } as const,
      "oversized" as const,
    ]) {
      clearDecodedMapCache();
      const subject = trying(first);
      const result = await symbolicateFrom(subject);
      expect(result.ok && result.target.location).toEqual(authored(2, 9));
      expect(subject.fetchSourceMap.mock.calls.map(([url]) => url)).toEqual([SERVER, DISK]);
    }
  });

  it("asks no further once the job is cancelled", async () => {
    const subject = trying({ ok: false, reason: "cancelled" });
    await expect(symbolicateFrom(subject)).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(subject.fetchSourceMap).toHaveBeenCalledTimes(1);
  });

  it("reports the last name's reason when none gives a map", async () => {
    const subject = fake(cardMap(), { fetched: { ok: false, reason: "file-missing" } });
    await expect(symbolicateFrom(subject)).resolves.toEqual({ ok: false, reason: "file-missing" });
    expect(subject.fetchSourceMap).toHaveBeenCalledTimes(2);
  });
});

describe("symbolicatedResult", () => {
  it("is mapped, naming the map, the file and the revision it was checked against", async () => {
    const result = symbolicatedResult(creation(), await symbolicate(fake(cardMap())));
    expect(result).toMatchObject({
      state: "mapped",
      candidateId: "c-1",
      claim: "element-creation",
      target: { file: { path: "src/Card.tsx" }, location: authored(2, 9) },
      sourceMap: { sourceCheck: "matches" },
    });
    expect(ResolutionResultSchema.safeParse(result).success).toBe(true);
  });

  it("is mapped with no revision when nothing could be checked", async () => {
    const result = symbolicatedResult(
      creation(),
      await symbolicate(fake(cardMap({ sourcesContent: undefined })))
    );
    expect(result).toMatchObject({
      state: "mapped",
      fileRevision: null,
      sourceMap: { sourceCheck: "unchecked" },
    });
    expect(ResolutionResultSchema.safeParse(result).success).toBe(true);
  });

  it("carries the reason when there is no mapping", () => {
    expect(symbolicatedResult(creation(), { ok: false, reason: "map-missing" })).toEqual({
      state: "unavailable",
      candidateId: "c-1",
      claim: "element-creation",
      reason: "map-missing",
    });
  });
});
