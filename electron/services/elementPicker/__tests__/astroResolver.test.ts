import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import {
  ResolveResponseSchema,
  type ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { astroResolver } from "../worker/resolvers/astro.js";
import { observation, request } from "./fixtures.js";

const ROOT = "/proj/";
const PAGE = "/proj/src/pages/index.astro";
const SOURCE = '---\nconst title = "Shop";\n---\n<main>\n  <h1>{title}</h1>\n</main>\n';

function revisionOf(bytes: Uint8Array): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Main's half, in miniature: a reported path under `/proj/` is placed, any
 * other refused, and a placed file is served from `files`.
 */
function fakeAccess(files: Record<string, string | Uint8Array>) {
  const reads: string[] = [];
  const access: ResolverSourceAccess = {
    locateFile: async (reported) =>
      reported.startsWith(ROOT)
        ? { ok: true, value: { workspaceId: "ws", path: reported.slice(ROOT.length) } }
        : { ok: false, reason: "outside-workspace" },
    readSource: async (file) => {
      reads.push(file.path);
      const content = files[file.path];
      if (content === undefined) return { ok: false, reason: "file-missing" };
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return { ok: true, value: { file, revision: revisionOf(bytes), bytes } };
    },
    fetchSourceMap: async () => ({ ok: false, reason: "unsupported" }),
    locateSource: async () => ({ ok: false, reason: "unsupported" }),
  };
  return { access, reads };
}

function located(
  line: number,
  column: number,
  file = PAGE,
  columnBase: 0 | 1 = 1
): SourceCandidate {
  return {
    kind: "template-location",
    candidateId: "astro-source",
    framework: "astro",
    extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
    file,
    location: { lineBase: 1, columnBase, columnUnit: "utf16", line, column },
  };
}

function hinted(file = PAGE): SourceCandidate {
  return {
    kind: "file-hint",
    candidateId: "astro-source",
    framework: "astro",
    extraction: { kind: "attribute", attribute: "data-astro-source-file" },
    file,
  };
}

function element(tagName: string, candidates: SourceCandidate[]): SelectionObservation {
  return { ...observation("el-1", candidates), tagName };
}

async function resolve(
  observations: SelectionObservation[],
  files: Record<string, string | Uint8Array> = { "src/pages/index.astro": SOURCE },
  knownRevisions: Array<{ path: string; revision: FileRevision }> = []
): Promise<{ results: ResolutionResult[]; reads: string[] }> {
  const { access, reads } = fakeAccess(files);
  const req = {
    ...request("ws", observations),
    knownRevisions: knownRevisions.map(({ path, revision }) => ({
      file: { workspaceId: "ws", path },
      revision,
    })),
  };
  const response = await astroResolver.resolve(req, access, new AbortController().signal);
  // Main admits nothing that does not fit the contract.
  expect(ResolveResponseSchema.safeParse(response).success).toBe(true);
  expect(response.requestId).toBe(req.requestId);
  return { results: response.outcomes.flatMap((outcome) => outcome.results), reads };
}

const SOURCE_REVISION = revisionOf(new TextEncoder().encode(SOURCE));
const pageRef = { workspaceId: "ws", path: "src/pages/index.astro" };

describe("astroResolver", () => {
  it("verifies a location the file holds, keeping the reported coordinates", async () => {
    const candidate = located(5, 7);
    const { results } = await resolve([element("h1", [candidate])]);
    expect(results).toEqual([
      {
        state: "verified",
        candidateId: "astro-source",
        claim: "template-location",
        target: {
          file: pageRef,
          location: candidate.kind === "file-hint" ? null : candidate.location,
        },
        fileRevision: SOURCE_REVISION,
      },
    ]);
  });

  it("names what it read when the file does not hold the claim", async () => {
    // One line off: an edit the page has not caught up with.
    const { results } = await resolve([element("h1", [located(4, 7)])]);
    expect(results).toEqual([
      {
        state: "unavailable",
        candidateId: "astro-source",
        claim: "template-location",
        reason: "mismatch",
        read: { file: pageRef, fileRevision: SOURCE_REVISION },
      },
    ]);
    // Nor does the right line hold another element.
    expect((await resolve([element("p", [located(5, 7)])])).results[0]).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
    });
  });

  it("reports the file it read, unchecked, when the check cannot settle", async () => {
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<h1>Hi</h1>")]);
    const notUtf8 = new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xff, 0x3c, 0x2f, 0x68, 0x31, 0x3e]);
    for (const bytes of [withMark, notUtf8]) {
      const { results } = await resolve([element("h1", [located(1, 5)])], {
        "src/pages/index.astro": bytes,
      });
      expect(results).toEqual([
        expect.objectContaining({
          state: "observed",
          target: { file: pageRef, location: expect.objectContaining({ line: 1, column: 5 }) },
          fileRevision: revisionOf(bytes),
        }),
      ]);
    }
  });

  it("verifies a file-only hint by reading the file, and never gives it a line", async () => {
    const { results } = await resolve([element("h1", [hinted()])]);
    expect(results).toEqual([
      {
        state: "verified",
        candidateId: "astro-source",
        claim: "file-hint",
        target: { file: pageRef, location: null },
        fileRevision: SOURCE_REVISION,
      },
    ]);
  });

  it("passes on why a file could not be placed or read, reading nothing it could not place", async () => {
    const outside = await resolve([element("h1", [located(5, 7, "/elsewhere/index.astro")])]);
    expect(outside.results[0]).toMatchObject({ state: "unavailable", reason: "outside-workspace" });
    expect(outside.reads).toEqual([]);

    const missing = await resolve([element("h1", [located(5, 7)])], {});
    expect(missing.results[0]).toMatchObject({ state: "unavailable", reason: "file-missing" });
  });

  it("reports a file that changed since an earlier result read it as stale, even where it still matches", async () => {
    const earlier = revisionOf(new TextEncoder().encode("<h1>old</h1>"));
    const changed = await resolve([element("h1", [located(5, 7)])], undefined, [
      { path: "src/pages/index.astro", revision: earlier },
    ]);
    expect(changed.results).toEqual([
      {
        state: "stale",
        candidateId: "astro-source",
        claim: "template-location",
        held: {
          state: "observed",
          target: { file: pageRef, location: expect.objectContaining({ line: 5, column: 7 }) },
          fileRevision: earlier,
        },
        currentFileRevision: SOURCE_REVISION,
        reason: "file-changed",
      },
    ]);

    const gone = await resolve([element("h1", [hinted()])], {}, [
      { path: "src/pages/index.astro", revision: earlier },
    ]);
    expect(gone.results[0]).toMatchObject({
      state: "stale",
      held: { target: { location: null } },
      currentFileRevision: null,
      reason: "file-missing",
    });

    const same = await resolve([element("h1", [located(5, 7)])], undefined, [
      { path: "src/pages/index.astro", revision: SOURCE_REVISION },
    ]);
    expect(same.results[0]?.state).toBe("verified");
  });

  it("checks a CRLF file at the coordinates the compiler counted, against its raw bytes", async () => {
    const crlf = SOURCE.replace(/\n/g, "\r\n");
    const { results } = await resolve([element("h1", [located(5, 7)])], {
      "src/pages/index.astro": crlf,
    });
    expect(results).toEqual([
      expect.objectContaining({
        state: "verified",
        fileRevision: revisionOf(new TextEncoder().encode(crlf)),
      }),
    ]);
  });

  it("reads nothing once placing the file was cancelled", async () => {
    const { access, reads } = fakeAccess({ "src/pages/index.astro": SOURCE });
    const controller = new AbortController();
    const cancelling: ResolverSourceAccess = {
      ...access,
      locateFile: async () => {
        controller.abort();
        return { ok: false, reason: "cancelled" };
      },
    };
    const response = await astroResolver.resolve(
      request("ws", [element("h1", [located(5, 7)])]),
      cancelling,
      controller.signal
    );
    expect(response.outcomes[0]?.results).toEqual([
      {
        state: "unavailable",
        candidateId: "astro-source",
        claim: "template-location",
        reason: "cancelled",
      },
    ]);
    expect(reads).toEqual([]);
  });

  it("checks only the claims the Astro extractor makes, and only against the element they are on", async () => {
    const field: SourceCandidate = {
      ...located(5, 7),
      candidateId: "field",
      extraction: { kind: "runtime-field", field: "__astro" },
    };
    const zeroBased: SourceCandidate = { ...located(5, 6, PAGE, 0), candidateId: "zero" };
    const onComponent = { ...located(5, 7), candidateId: "component" };
    const { results, reads } = await resolve([
      observation("el-1", [field, zeroBased], [onComponent]),
    ]);
    expect(results.map((result) => [result.candidateId, result.state])).toEqual([
      ["field", "unavailable"],
      ["zero", "unavailable"],
      ["component", "unavailable"],
    ]);
    expect(
      results.every((result) => result.state === "unavailable" && result.reason === "unsupported")
    ).toBe(true);
    expect(reads).toEqual([]);
  });
});
