import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COORDINATE_CONVENTIONS,
  type SourceLocation,
} from "../../../../shared/elementPicker/coordinates.js";
import type { ComponentRecord } from "../../../../shared/elementPicker/component.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import type {
  ResolveBudget,
  ResolveRequest,
  ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { checkResolveResponse } from "../checkResponse.js";
import { observationCandidates } from "../outcomes.js";
import { JobSourceAccess } from "../sourceAccess.js";
import { vueResolver } from "../worker/resolvers/vue.js";

/**
 * The Vue resolver against real files through main's own source access: a
 * temp monorepo whose app is not its worktree, real containment and bounded
 * reads, and every answer held to the checks main applies before it passes
 * one on. Stamps are written the way `vite-plugin-vue-inspector` writes them:
 * Vue's parser positions, 1-based, over the whole file.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures", "vue");
const WORKSPACE = "ws-1";
const APP = "apps/shop";
const BUDGET: ResolveBudget = {
  maxFiles: 32,
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
};

let root: string;
let worktree: string;
let appRoot: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "picker-vue-")));
  worktree = path.join(root, "worktree");
  appRoot = path.join(worktree, ...APP.split("/"));
  await write("package.json", JSON.stringify({ name: "shop", devDependencies: { vue: "^3.5.0" } }));
  for (const name of ["App.vue", "Badge.vue", "Card.vue"]) {
    await write(`src/${name}`, await fs.readFile(path.join(FIXTURES, name)));
  }
  await write(
    "node_modules/nuxt/dist/app/components/nuxt-root.vue",
    "<template><div /></template>\n"
  );
  await write(".nuxt/components/island.vue", "<template><div /></template>\n");
  await fs.writeFile(path.join(root, "outside.vue"), "<template><p>outside</p></template>\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(appRelative: string, contents: string | Uint8Array): Promise<void> {
  const target = path.join(appRoot, ...appRelative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function text(appRelative: string): Promise<string> {
  return fs.readFile(path.join(appRoot, ...appRelative.split("/")), "utf8");
}

function revisionOf(bytes: Uint8Array | string): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function revisionOfFile(appRelative: string): Promise<FileRevision> {
  return revisionOf(await fs.readFile(path.join(appRoot, ...appRelative.split("/"))));
}

function ref(appRelative: string) {
  return { workspaceId: WORKSPACE, path: `${APP}/${appRelative}` };
}

/** Vue's parser position for where `marker` starts: a BOM is a character like any other. */
function stampAt(source: string, marker: string, from = 0): SourceLocation {
  const offset = source.indexOf(marker, from);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  return {
    ...COORDINATE_CONVENTIONS.vueInspector,
    columnUnit: "utf16",
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
}

/** The range a verified tag resolves to, as an editor shows the file: no BOM, 1-based lines, 0-based columns. */
function rangeOf(source: string, start: string, end: string): SourceLocation {
  const content = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const position = (offset: number) => {
    const before = content.slice(0, offset);
    return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) };
  };
  const from = content.indexOf(start);
  const to = content.indexOf(end, from) + end.length;
  return {
    ...COORDINATE_CONVENTIONS.sourceMap,
    columnUnit: "utf16",
    ...position(from),
    end: position(to),
  };
}

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function templateLocation(file: string, location: SourceLocation): SourceCandidate {
  return {
    kind: "template-location",
    candidateId: id("c"),
    framework: "vue",
    extraction: { kind: "attribute", attribute: "data-v-inspector" },
    file,
    location,
  };
}

function invocation(file: string, location: SourceLocation): SourceCandidate {
  return {
    kind: "component-invocation",
    candidateId: id("c"),
    framework: "vue",
    extraction: { kind: "runtime-field", field: "vnode.props.__v_inspector" },
    file,
    location,
  };
}

function fileHint(file: string): SourceCandidate {
  return {
    kind: "file-hint",
    candidateId: id("c"),
    framework: "vue",
    extraction: { kind: "runtime-field", field: "type.__file" },
    file,
  };
}

function component(sourceCandidates: SourceCandidate[]): ComponentRecord {
  return {
    componentId: id("component"),
    framework: "vue",
    name: null,
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates,
  };
}

function selection(
  options: {
    tagName?: string;
    sourceCandidates?: SourceCandidate[];
    components?: ComponentRecord[];
  } = {}
): SelectionObservation {
  const unknown = { state: "unknown" } as const;
  const components = options.components ?? [];
  return {
    phase: "selection",
    elementId: id("el"),
    tagName: options.tagName ?? "button",
    label: "node",
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    detections: [],
    componentChain: { nearestId: components[0]?.componentId ?? null, components, truncated: false },
    sourceCandidates: options.sourceCandidates ?? [],
    capabilities: {
      names: unknown,
      chain: unknown,
      componentSelection: unknown,
      file: unknown,
      line: unknown,
      exactRange: unknown,
    },
    frameworkEvidence: [],
  };
}

interface Resolved {
  results: ResolutionResult[];
  /** Every ref the resolver asked main to read, worktree-relative, in order. */
  reads: string[];
}

async function resolveAll(
  observations: SelectionObservation[],
  options: { knownRevisions?: ResolveRequest["knownRevisions"]; cancelled?: boolean } = {}
): Promise<Resolved> {
  const controller = new AbortController();
  const roots = { worktreePath: worktree, appRoot };
  const job = new JobSourceAccess({
    workspaceId: WORKSPACE,
    roots,
    budget: BUDGET,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: null,
    sourceMaps: async () => ({ ok: false, reason: "unsupported" }),
    onRead: () => {},
  });
  const reads: string[] = [];
  const access: ResolverSourceAccess = {
    readSource: (file) => {
      reads.push(file.path);
      return job.readSource(file);
    },
    fetchSourceMap: (generatedUrl) => job.fetchSourceMap(generatedUrl),
    locateSource: ({ generatedUrl, source, sourceRoot }) =>
      job.locateSource(generatedUrl, source, sourceRoot),
    locateFile: async (reported) => job.locateFile(reported),
  };
  const request: ResolveRequest = {
    requestId: id("request"),
    sessionId: "session",
    documentEpoch: 3,
    workspaceId: WORKSPACE,
    observations,
    knownRevisions: options.knownRevisions ?? [],
    budget: BUDGET,
  };
  if (options.cancelled) controller.abort();
  const response = await vueResolver.resolve(request, access, controller.signal);
  // Exactly one answer per candidate, in the order the request listed them...
  expect(
    response.outcomes.map((outcome) => outcome.results.map((result) => result.candidateId))
  ).toEqual(
    observations.map((observation) =>
      observationCandidates(observation).map((candidate) => candidate.candidateId)
    )
  );
  // ...and one main would pass on: contained, revisions it served, claims kept.
  expect(
    checkResolveResponse(request, response, {
      roots,
      servedRevision: (file) => job.servedRevision(file),
      servedMap: (mapUrl, revision) => job.servedMap(mapUrl, revision),
    })
  ).toEqual(response);
  controller.abort();
  return { results: response.outcomes.flatMap((outcome) => outcome.results), reads };
}

async function resolveOne(
  observation: SelectionObservation,
  options: Parameters<typeof resolveAll>[1] = {}
): Promise<ResolutionResult> {
  const { results } = await resolveAll([observation], options);
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("the Vue resolver's element locations", () => {
  it("verifies the element's whole range at the revision of the bytes on disk", async () => {
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        sourceCandidates: [templateLocation("src/App.vue", stampAt(source, '<button class="cta"'))],
      })
    );
    expect(result).toEqual({
      state: "verified",
      candidateId: expect.any(String),
      claim: "template-location",
      target: {
        file: ref("src/App.vue"),
        location: rangeOf(source, '<button class="cta"', "</button>"),
      },
      fileRevision: await revisionOfFile("src/App.vue"),
    });
  });

  it("names a file reported by its absolute path inside the app", async () => {
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        sourceCandidates: [
          templateLocation(
            path.join(appRoot, "src", "App.vue"),
            stampAt(source, '<button class="cta"')
          ),
        ],
      })
    );
    expect(result).toMatchObject({ state: "verified", target: { file: ref("src/App.vue") } });
  });

  it("reads a position in the convention it was reported in", async () => {
    const source = await text("src/App.vue");
    const stamp = stampAt(source, '<button class="cta"');
    const shifted = {
      ...stamp,
      lineBase: 0,
      columnBase: 0,
      line: stamp.line - 1,
      column: stamp.column - 1,
    } as const;
    const result = await resolveOne(
      selection({ sourceCandidates: [templateLocation("src/App.vue", shifted)] })
    );
    expect(result).toMatchObject({
      state: "verified",
      target: { location: rangeOf(source, '<button class="cta"', "</button>") },
    });
  });

  it("refuses a stamp whose tag is not the element's, and says what it read", async () => {
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        tagName: "span",
        sourceCandidates: [templateLocation("src/App.vue", stampAt(source, '<button class="cta"'))],
      })
    );
    expect(result).toEqual({
      state: "unavailable",
      candidateId: expect.any(String),
      claim: "template-location",
      reason: "mismatch",
      read: { file: ref("src/App.vue"), fileRevision: await revisionOfFile("src/App.vue") },
    });
  });

  it("never takes a component's call site for the element its stamp fell through to", async () => {
    // A root element can carry the stamp of the tag that used its component.
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        tagName: "span",
        sourceCandidates: [templateLocation("src/App.vue", stampAt(source, '<Badge :count="3"'))],
      })
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("finds no tag where a stamp lands off one", async () => {
    const source = await text("src/App.vue");
    const inside = stampAt(source, 'class="cta"');
    const result = await resolveOne(
      selection({ sourceCandidates: [templateLocation("src/App.vue", inside)] })
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("matches only tags in the template, never the same text in a comment, an attribute, an interpolation or the script", async () => {
    const tricky = [
      "<script setup>",
      'const markup = "<button>";',
      "</script>",
      "",
      "<template>",
      "  <div :title=\"'<button>'\">",
      "    <!-- <button>old</button> -->",
      "    {{ '<button>' }}",
      "    <button>real</button>",
      "  </div>",
      "</template>",
      "",
      "<docs><button>docs</button></docs>",
      "",
    ].join("\n");
    await write("src/Tricky.vue", tricky);
    const fakes = ['"<button>";', "'<button>'\">", "<button>old", "'<button>' }}", "<button>docs"];
    for (const marker of fakes) {
      const at = stampAt(tricky, marker);
      // Every fake sits where `<button` does; the column is moved onto it.
      const offset = tricky.indexOf(marker) + marker.indexOf("<button");
      const location = { ...at, column: at.column + (offset - tricky.indexOf(marker)) };
      const result = await resolveOne(
        selection({ sourceCandidates: [templateLocation("src/Tricky.vue", location)] })
      );
      expect(result, marker).toMatchObject({ state: "unavailable", reason: "mismatch" });
    }
    const real = await resolveOne(
      selection({
        sourceCandidates: [templateLocation("src/Tricky.vue", stampAt(tricky, "<button>real"))],
      })
    );
    expect(real).toMatchObject({ state: "verified" });
  });

  it("measures the range without the BOM the parser counted, through CRLF line ends", async () => {
    const crlf = '﻿<template><button class="first">a</button>\r\n  <i>b</i></template>\r\n';
    await write("src/Bom.vue", crlf);
    const first = await resolveOne(
      selection({ sourceCandidates: [templateLocation("src/Bom.vue", stampAt(crlf, "<button"))] })
    );
    // The parser's column on line 1 counts the BOM; an editor's does not.
    expect(stampAt(crlf, "<button").column).toBe(12);
    expect(first).toMatchObject({
      state: "verified",
      target: { location: { line: 1, column: 10, end: { line: 1, column: 42 } } },
    });
    const second = await resolveOne(
      selection({
        tagName: "i",
        sourceCandidates: [templateLocation("src/Bom.vue", stampAt(crlf, "<i>"))],
      })
    );
    expect(second).toMatchObject({
      state: "verified",
      target: { location: { line: 2, column: 2, end: { line: 2, column: 10 } } },
    });
  });

  it("vouches for no template it cannot parse as Vue would: another language, an external one, or one that does not parse", async () => {
    const files = {
      "src/Pug.vue": '<template lang="pug">\nbutton.cta Go\n</template>\n',
      "src/External.vue": '<template src="./external.html"></template>\n',
      "src/Broken.vue": "<template>\n  <div><button>go</div>\n</template>\n",
    };
    for (const [file, contents] of Object.entries(files)) {
      await write(file, contents);
      const at = contents.includes("<button")
        ? stampAt(contents, "<button")
        : stampAt(contents, "<template");
      const result = await resolveOne(
        selection({ sourceCandidates: [templateLocation(file, at)] })
      );
      expect(result, file).toMatchObject({
        state: "unavailable",
        reason: "unsupported",
        read: { file: ref(file) },
      });
    }
  });
});

describe("the Vue resolver's component call sites", () => {
  it("verifies a component tag at the stamp its record carries", async () => {
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        components: [component([invocation("src/App.vue", stampAt(source, '<Badge :count="3"'))])],
      })
    );
    expect(result).toEqual({
      state: "verified",
      candidateId: expect.any(String),
      claim: "component-invocation",
      target: { file: ref("src/App.vue"), location: rangeOf(source, '<Badge :count="3"', "/>") },
      fileRevision: await revisionOfFile("src/App.vue"),
    });
    expect(result).not.toHaveProperty("definition");
  });

  it("refuses a call site that lands on a plain element", async () => {
    const source = await text("src/App.vue");
    const result = await resolveOne(
      selection({
        components: [component([invocation("src/App.vue", stampAt(source, '<main class="app"'))])],
      })
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });
});

describe("the Vue resolver's file hints", () => {
  it("names the file and holds it to a revision, never a line", async () => {
    const result = await resolveOne(
      selection({ components: [component([fileHint(path.join(appRoot, "src", "Card.vue"))])] })
    );
    expect(result).toEqual({
      state: "observed",
      candidateId: expect.any(String),
      claim: "file-hint",
      target: { file: ref("src/Card.vue"), location: null },
      fileRevision: await revisionOfFile("src/Card.vue"),
    });
  });

  it("leaves a dependency's file and Nuxt's generated output alone", async () => {
    const source = "<template><div /></template>\n";
    const { results } = await resolveAll([
      selection({
        tagName: "div",
        sourceCandidates: [
          templateLocation(".nuxt/components/island.vue", stampAt(source, "<div")),
        ],
        components: [
          component([
            fileHint(
              path.join(
                appRoot,
                "node_modules",
                "nuxt",
                "dist",
                "app",
                "components",
                "nuxt-root.vue"
              )
            ),
          ]),
        ],
      }),
    ]);
    expect(
      results.map((result) => [result.state, result.state === "unavailable" && result.reason])
    ).toEqual([
      ["unavailable", "unsupported"],
      ["unavailable", "unsupported"],
    ]);
  });

  it("refuses a file outside the app, and says which one is missing", async () => {
    const { results } = await resolveAll([
      selection({
        components: [
          component([fileHint(path.join(root, "outside.vue")), fileHint("src/Gone.vue")]),
        ],
      }),
    ]);
    expect(results).toMatchObject([
      { state: "unavailable", reason: "outside-workspace" },
      { state: "unavailable", reason: "file-missing" },
    ]);
  });
});

describe("the Vue resolver across a request", () => {
  it("reads each file once however many claims it answers there", async () => {
    const source = await text("src/App.vue");
    const { results, reads } = await resolveAll([
      selection({
        sourceCandidates: [
          templateLocation("src/App.vue", stampAt(source, '<button class="cta"')),
          fileHint(path.join(appRoot, "src", "App.vue")),
        ],
        components: [component([invocation("src/App.vue", stampAt(source, '<Badge :count="3"'))])],
      }),
    ]);
    expect(results.map((result) => result.state)).toEqual(["verified", "observed", "verified"]);
    expect(reads).toEqual([`${APP}/src/App.vue`]);
  });

  it("reports a file changed since an earlier result as stale, and one since deleted too", async () => {
    const source = await text("src/App.vue");
    const before = await revisionOfFile("src/App.vue");
    await write("src/App.vue", `${source}\n<!-- edited -->\n`);
    const changed = await resolveOne(
      selection({
        sourceCandidates: [templateLocation("src/App.vue", stampAt(source, '<button class="cta"'))],
      }),
      { knownRevisions: [{ file: ref("src/App.vue"), revision: before }] }
    );
    expect(changed).toMatchObject({
      state: "stale",
      reason: "file-changed",
      currentFileRevision: await revisionOfFile("src/App.vue"),
      held: { target: { file: ref("src/App.vue") }, fileRevision: before },
    });

    const card = await revisionOfFile("src/Card.vue");
    await fs.rm(path.join(appRoot, "src", "Card.vue"));
    const gone = await resolveOne(
      selection({ components: [component([fileHint("src/Card.vue")])] }),
      { knownRevisions: [{ file: ref("src/Card.vue"), revision: card }] }
    );
    expect(gone).toMatchObject({
      state: "stale",
      reason: "file-missing",
      currentFileRevision: null,
      held: { target: { location: null } },
    });
  });

  it("answers claims it has no reading for as unsupported", async () => {
    const source = await text("src/App.vue");
    const at = stampAt(source, '<button class="cta"');
    const { results } = await resolveAll([
      selection({
        sourceCandidates: [
          { ...templateLocation("src/App.vue", at), kind: "element-creation", location: at },
        ],
        components: [
          component([
            {
              kind: "component-definition",
              candidateId: id("c"),
              framework: "vue",
              extraction: { kind: "runtime-field", field: "type.__file" },
              file: "src/App.vue",
              location: at,
            },
          ]),
        ],
      }),
    ]);
    expect(results).toMatchObject([
      { state: "unavailable", reason: "unsupported", claim: "element-creation" },
      { state: "unavailable", reason: "unsupported", claim: "component-definition" },
    ]);
  });

  it("finishes nothing for a job withdrawn before it began", async () => {
    const source = await text("src/App.vue");
    const { results, reads } = await resolveAll(
      [
        selection({
          sourceCandidates: [
            templateLocation("src/App.vue", stampAt(source, '<button class="cta"')),
          ],
          components: [component([fileHint("src/Card.vue")])],
        }),
      ],
      { cancelled: true }
    );
    expect(results.map((result) => result.state === "unavailable" && result.reason)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(reads).toEqual([]);
  });
});
