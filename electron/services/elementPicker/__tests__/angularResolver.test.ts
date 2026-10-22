import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { ComponentRecord } from "../../../../shared/elementPicker/component.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../shared/elementPicker/resolution.js";
import type {
  ResolveRequest,
  ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { checkResolveResponse } from "../checkResponse.js";
import { observationCandidates } from "../outcomes.js";
import { JobSourceAccess, type SourceRoots } from "../sourceAccess.js";
import { angularResolver, declaresClass } from "../worker/resolvers/angular.js";

/**
 * The Angular resolver against real files through main's own source access:
 * a temp monorepo whose Angular workspace is not its worktree, real
 * containment and bounded reads, and every answer held to the checks main
 * applies before it passes one on. Observations are shaped as the Angular
 * extractor reports them.
 */

const WORKSPACE = "ws-1";
/** Where the Angular workspace sits in the worktree; `ng serve` reports paths relative to it. */
const APP = "apps/shop";

const BUTTON_TS = `import { Component } from "@angular/core";

@Component({
  selector: "app-button",
  templateUrl: "./button.component.html",
})
export class ButtonComponent {}
`;

const BUTTON_HTML = `<div class="wrap">
  <button class="go">Go</button>
</div>
`;

const APP_HTML = `<main>
  <app-card>
    <app-button />
  </app-card>
</main>
`;

let root: string;
let roots: SourceRoots;

async function put(appRelative: string, contents: string | Uint8Array): Promise<void> {
  const target = path.join(roots.appRoot, ...appRelative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "picker-angular-")));
  const worktree = path.join(root, "worktree");
  roots = { worktreePath: worktree, appRoot: path.join(worktree, ...APP.split("/")) };
  await put("src/app/button.component.ts", BUTTON_TS);
  await put("src/app/button.component.html", BUTTON_HTML);
  await put("src/app/app.component.html", APP_HTML);
  await fs.writeFile(path.join(root, "outside.ts"), "export class ButtonComponent {}\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function ref(appRelative: string) {
  return { workspaceId: WORKSPACE, path: `${APP}/${appRelative}` };
}

function revisionOf(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** As `data-ng-source-location` reports a position: 0-based line and column. */
function stampAt(source: string, marker: string): SourceLocation & { offset: number } {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  return {
    lineBase: 0,
    columnBase: 0,
    columnUnit: "utf16",
    line: before.split("\n").length - 1,
    column: offset - (before.lastIndexOf("\n") + 1),
    offset,
  };
}

function classFile(file: string): SourceCandidate {
  return {
    kind: "file-hint",
    candidateId: id("c"),
    framework: "angular",
    extraction: { kind: "runtime-field", field: "constructor.ɵcmp.debugInfo.filePath" },
    file,
  };
}

function stamped(
  kind: "template-location" | "component-invocation",
  file: string,
  { offset: _offset, ...location }: SourceLocation & { offset: number }
): SourceCandidate {
  return {
    kind,
    candidateId: id("c"),
    framework: "angular",
    extraction: { kind: "attribute", attribute: "data-ng-source-location" },
    file,
    location,
  };
}

function component(
  sourceCandidates: SourceCandidate[],
  name: { value: string; field: string } | null = {
    value: "ButtonComponent",
    field: "constructor.ɵcmp.debugInfo.className",
  }
): ComponentRecord {
  return {
    componentId: id("angular"),
    framework: "angular",
    name:
      name === null
        ? null
        : { value: name.value, extraction: { kind: "runtime-field", field: name.field } },
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
    templateOffset?: number | null;
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
    frameworkEvidence: [
      {
        kind: "generic",
        framework: "angular",
        fields: [
          { name: "debugApi", value: true },
          { name: "templateOffset", value: options.templateOffset ?? null },
        ],
      },
    ],
  };
}

async function resolve(
  observation: SelectionObservation,
  options: { knownRevisions?: ResolveRequest["knownRevisions"]; cancel?: boolean } = {}
): Promise<ResolutionResult[]> {
  const controller = new AbortController();
  const budget = {
    maxFiles: 32,
    maxFileBytes: 1024 * 1024,
    maxNetworkRequests: 8,
    maxNetworkBytes: 4 * 1024 * 1024,
    deadlineMs: 5_000,
  };
  const job = new JobSourceAccess({
    workspaceId: WORKSPACE,
    roots,
    budget,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: null,
    sourceMaps: async () => ({ ok: false, reason: "unsupported" }),
    onRead: () => {},
  });
  const access: ResolverSourceAccess = {
    readSource: (file) => job.readSource(file),
    fetchSourceMap: (generatedUrl) => job.fetchSourceMap(generatedUrl),
    locateSource: ({ generatedUrl, source, sourceRoot }) =>
      job.locateSource(generatedUrl, source, sourceRoot),
    locateFile: async (reported) => job.locateFile(reported),
  };
  const request: ResolveRequest = {
    requestId: id("request"),
    sessionId: "session",
    documentEpoch: 1,
    workspaceId: WORKSPACE,
    observations: [observation],
    knownRevisions: options.knownRevisions ?? [],
    budget,
  };
  if (options.cancel) controller.abort();
  const response = await angularResolver.resolve(request, access, controller.signal);
  // One answer per candidate, in the request's order, and one main would pass on.
  expect(response.outcomes[0]!.results.map((result) => result.candidateId)).toEqual(
    observationCandidates(observation).map((candidate) => candidate.candidateId)
  );
  expect(
    checkResolveResponse(request, response, {
      roots,
      servedRevision: (file) => job.servedRevision(file),
      servedMap: (mapUrl, revision) => job.servedMap(mapUrl, revision),
    })
  ).toEqual(response);
  return response.outcomes[0]!.results;
}

async function resolveOne(observation: SelectionObservation): Promise<ResolutionResult> {
  const results = await resolve(observation);
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("the Angular resolver on a class's file", () => {
  it("verifies the file the compiler named once it declares the class by its compiled name", async () => {
    const hint = classFile("src/app/button.component.ts");
    const result = await resolveOne(selection({ components: [component([hint])] }));
    expect(result).toEqual({
      state: "verified",
      candidateId: hint.candidateId,
      claim: "file-hint",
      target: { file: ref("src/app/button.component.ts"), location: null },
      fileRevision: revisionOf(BUTTON_TS),
    });
  });

  it("refuses a file that only names the class in a comment, a string or an import", async () => {
    await put(
      "src/app/impostor.ts",
      [
        "// export class ButtonComponent {}",
        "/* class ButtonComponent */",
        'const note = "class ButtonComponent";',
        "const tpl = `class ButtonComponent`;",
        'import { ButtonComponent } from "./button.component";',
        "export class ButtonComponentWrapper extends ButtonComponent {}",
        "",
      ].join("\n")
    );
    const result = await resolveOne(
      selection({ components: [component([classFile("src/app/impostor.ts")])] })
    );
    expect(result).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref("src/app/impostor.ts") },
    });
  });

  it("holds the file to nothing when the record's name is not the compiled one", async () => {
    const result = await resolveOne(
      selection({
        components: [
          component([classFile("src/app/button.component.ts")], {
            value: "_ButtonComponent",
            field: "constructor.name",
          }),
        ],
      })
    );
    expect(result).toMatchObject({
      state: "observed",
      target: { file: ref("src/app/button.component.ts"), location: null },
    });
  });

  it.each([
    ["a file that is not there", "src/app/missing.component.ts", "file-missing"],
    ["a path out of the app", "../../../outside.ts", "outside-workspace"],
  ])("names no file for %s", async (_label, file, reason) => {
    const result = await resolveOne(selection({ components: [component([classFile(file)])] }));
    expect(result).toMatchObject({ state: "unavailable", reason });
  });

  it("reports a file changed since an earlier result as stale", async () => {
    const hint = classFile("src/app/button.component.ts");
    const [result] = await resolve(selection({ components: [component([hint])] }), {
      knownRevisions: [{ file: ref("src/app/button.component.ts"), revision: revisionOf("old") }],
    });
    expect(result).toMatchObject({
      state: "stale",
      reason: "file-changed",
      currentFileRevision: revisionOf(BUTTON_TS),
    });
  });

  it("answers work the job was withdrawn from as cancelled", async () => {
    const [result] = await resolve(
      selection({ components: [component([classFile("src/app/button.component.ts")])] }),
      { cancel: true }
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "cancelled" });
  });
});

describe("the Angular resolver on template stamps", () => {
  it("verifies an element's stamp where its own tag opens at the stamped line, column and offset", async () => {
    const at = stampAt(BUTTON_HTML, '<button class="go">');
    const { offset, ...location } = at;
    const candidate = stamped("template-location", "src/app/button.component.html", at);
    const result = await resolveOne(
      selection({ sourceCandidates: [candidate], templateOffset: offset })
    );
    expect(result).toEqual({
      state: "verified",
      candidateId: candidate.candidateId,
      claim: "template-location",
      target: { file: ref("src/app/button.component.html"), location },
      fileRevision: revisionOf(BUTTON_HTML),
    });
  });

  it.each([
    ["another element's tag", { tagName: "a" }],
    ["a different offset", { offset: 3 }],
    ["a column off by one", { column: 1 }],
    ["a line past the file", { line: 40 }],
  ])("refuses an element's stamp with %s", async (_label, change) => {
    const at = stampAt(BUTTON_HTML, '<button class="go">');
    const location = {
      ...at,
      ...("column" in change ? { column: at.column + (change.column ?? 0) } : {}),
      ...("line" in change ? { line: change.line } : {}),
    };
    const result = await resolveOne(
      selection({
        tagName: "tagName" in change ? change.tagName : "button",
        sourceCandidates: [stamped("template-location", "src/app/button.component.html", location)],
        templateOffset: "offset" in change ? change.offset : at.offset,
      })
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("verifies a host's stamp as the place its declaring template uses the component", async () => {
    const candidate = stamped(
      "component-invocation",
      "src/app/app.component.html",
      stampAt(APP_HTML, "<app-button")
    );
    const result = await resolveOne(selection({ components: [component([candidate])] }));
    expect(result).toMatchObject({
      state: "verified",
      claim: "component-invocation",
      target: { file: ref("src/app/app.component.html") },
    });
  });

  it("refuses a host's stamp that lands on no tag", async () => {
    const at = stampAt(APP_HTML, "app-button />");
    const result = await resolveOne(
      selection({
        components: [
          component([stamped("component-invocation", "src/app/app.component.html", at)]),
        ],
      })
    );
    expect(result).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("reads each file once for every claim in it", async () => {
    const card = stamped(
      "component-invocation",
      "src/app/app.component.html",
      stampAt(APP_HTML, "<app-card")
    );
    const button = stamped(
      "component-invocation",
      "src/app/app.component.html",
      stampAt(APP_HTML, "<app-button")
    );
    const results = await resolve(
      selection({ components: [component([button]), component([card])] })
    );
    expect(results.map((result) => result.state)).toEqual(["verified", "verified"]);
    expect(
      new Set(results.map((result) => "fileRevision" in result && result.fileRevision)).size
    ).toBe(1);
  });

  it("leaves claims it has no way to check unsupported", async () => {
    const unplaced: SourceCandidate = {
      kind: "template-location",
      candidateId: id("c"),
      framework: "angular",
      extraction: { kind: "attribute", attribute: "data-ng-source-location" },
      file: "src/app/button.component.html",
      location: null,
    };
    const results = await resolve(
      selection({ sourceCandidates: [unplaced, classFile("src/app/button.component.ts")] })
    );
    expect(results.map((result) => result.state === "unavailable" && result.reason)).toEqual([
      "unsupported",
      "unsupported",
    ]);
  });
});

describe("declaresClass", () => {
  it.each([
    ["export class ButtonComponent {}", true],
    ["export default class ButtonComponent {}", true],
    ["export abstract class ButtonComponent<T> implements OnInit {}", true],
    ["@Component({})\nclass\n  ButtonComponent {}", true],
    ["export class ButtonComponentBase {}", false],
    ["export subclass ButtonComponent {}", false],
    ["const tpl = `${a}class ButtonComponent`;", false],
    ['const s = "it\'s a class ButtonComponent";', false],
    ["const ButtonComponent = class {};", false],
  ])("%s -> %s", (source, expected) => {
    expect(declaresClass(source, "ButtonComponent")).toBe(expected);
  });
});
