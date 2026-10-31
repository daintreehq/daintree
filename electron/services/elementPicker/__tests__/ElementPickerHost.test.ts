import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../../elementPickerProviderRegistry.js";
import {
  ElementPickerHost,
  MAX_SOURCE_REVISION_PATHS,
  type ElementPickerHostOptions,
} from "../ElementPickerHost.js";
import {
  RESOLVE_BUDGET_CEILINGS,
  type HostSourceResolver,
  type ResolveResponse,
} from "../../../../shared/elementPicker/resolver.js";
import type { ResolverLoaders } from "../worker/runtime.js";
import { RESOLVER_LOADERS } from "../worker/resolverRegistry.js";
import type { ProjectAdapter, ProjectAdapterRegistration } from "../projectAdapters/types.js";
import type { SourceChange } from "../sourceTracker.js";
import { revisionOf, type SourceMapProvider } from "../sourceAccess.js";
import { createSourceMapSymbolicator, symbolicatedResult } from "../worker/symbolication.js";
import { COORDINATE_CONVENTIONS } from "../../../../shared/elementPicker/coordinates.js";
import { ELEMENT_PICKER_MAX_HELD_SOURCES } from "../../../../shared/types/ipc/elementPicker.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../shared/elementPicker/resolution.js";
import {
  RuntimeChild,
  STUB_MARKER,
  type RuntimeChildOptions,
  candidate,
  observation,
  request,
  stallingResolver,
  stubResolver,
} from "./fixtures.js";

let root: string;
const hosts: ElementPickerHost[] = [];

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picker-host-")));
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "other"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "src", "App.svelte"), `<h1>${STUB_MARKER}</h1>`);
  fs.writeFileSync(path.join(root, "app", "src", "Plain.svelte"), "<p>plain</p>");
  fs.writeFileSync(path.join(root, "other", "Elsewhere.svelte"), `<p>${STUB_MARKER}</p>`);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  host: ElementPickerHost;
  children: RuntimeChild[];
  kill: ReturnType<typeof vi.fn>;
  watched: Map<string, (changedPath: string) => void>;
}

function harness(
  loaders: ResolverLoaders | (() => ResolverLoaders) = { svelte: async () => stubResolver() },
  options: ElementPickerHostOptions & { child?: RuntimeChildOptions } = {}
): Harness {
  const children: RuntimeChild[] = [];
  const watched = new Map<string, (changedPath: string) => void>();
  const kill = vi.fn((pid: number) => children.find((child) => child.pid === pid)?.exit(9));
  const host = new ElementPickerHost({
    fork: () => {
      const child = new RuntimeChild(
        typeof loaders === "function" ? loaders() : loaders,
        options.child
      );
      children.push(child);
      return child;
    },
    kill,
    watch: (directory, onChange) => {
      watched.set(directory, onChange);
      return () => watched.delete(directory);
    },
    idleMs: 60_000,
    ...options,
  });
  hosts.push(host);
  return { host, children, kill, watched };
}

async function workspace(
  host: ElementPickerHost,
  onSourceChanged: (change: SourceChange) => void = () => {}
): Promise<string> {
  return host.registerWorkspace({
    worktreePath: root,
    appRoot: path.join(root, "app"),
    onSourceChanged,
  });
}

function sha256(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

/** Captures a rejection the moment the call is made, so it is never unhandled while a test waits. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

function results(response: ResolveResponse) {
  return response.outcomes.flatMap((outcome) => outcome.results);
}

/** Where `marker` starts in `source`: 1-based line and column, as each stamp below counts them. */
function positionOf(source: string, marker: string) {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  return {
    columnUnit: "utf16" as const,
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
}

interface FrameworkApp {
  /** Worktree-relative, as a result names it. */
  path: string;
  /** A change the dev server would hot-reload, leaving every claim where it was. */
  edit: string;
  select(elementId: string, candidateId: string): SelectionObservation;
}

/**
 * An app for one of the frameworks the registry lists beyond Svelte and React:
 * a file under `<worktree>/app`, and a selection shaped as that framework's
 * extractor reports it, which the file bears out.
 */
function writeFrameworkApp(
  framework: "vue" | "angular" | "astro" | "preact",
  worktree: string
): FrameworkApp {
  const write = (appRelative: string, contents: string) => {
    const file = path.join(worktree, "app", ...appRelative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  switch (framework) {
    case "vue": {
      const source =
        '<template>\n  <main>\n    <button class="cta">Go</button>\n  </main>\n</template>\n';
      write("src/App.vue", source);
      return {
        path: "app/src/App.vue",
        edit: "\n<style>\n.cta { color: red; }\n</style>\n",
        select: (elementId, candidateId) => ({
          ...observation(elementId, [
            {
              kind: "template-location",
              candidateId,
              framework,
              extraction: { kind: "attribute", attribute: "data-v-inspector" },
              file: "src/App.vue",
              location: {
                ...COORDINATE_CONVENTIONS.vueInspector,
                ...positionOf(source, '<button class="cta"'),
              },
            },
          ]),
          tagName: "button",
        }),
      };
    }
    case "angular": {
      write(
        "src/app/button.component.ts",
        'import { Component } from "@angular/core";\n\n@Component({ selector: "app-button", template: "<button>Go</button>" })\nexport class ButtonComponent {}\n'
      );
      return {
        path: "app/src/app/button.component.ts",
        edit: "\nexport const edited = true;\n",
        select: (elementId, candidateId) => {
          const selected = {
            ...observation(
              elementId,
              [],
              [
                {
                  kind: "file-hint",
                  candidateId,
                  framework,
                  extraction: {
                    kind: "runtime-field",
                    field: "constructor.ɵcmp.debugInfo.filePath",
                  },
                  file: "src/app/button.component.ts",
                },
              ]
            ),
            tagName: "button",
          };
          // The compiled name is what the file is held to.
          selected.componentChain.components[0]!.name = {
            value: "ButtonComponent",
            extraction: { kind: "runtime-field", field: "constructor.ɵcmp.debugInfo.className" },
          };
          return selected;
        },
      };
    }
    case "astro": {
      const source = "<main>\n  <h1>Shop</h1>\n</main>\n";
      const file = write("src/pages/index.astro", source);
      return {
        path: "app/src/pages/index.astro",
        edit: "\n<style>\n  h1 { color: red; }\n</style>\n",
        select: (elementId, candidateId) => ({
          ...observation(elementId, [
            {
              kind: "template-location",
              candidateId,
              framework,
              extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
              file,
              // The compiler stamps an element with children at its first child.
              location: { ...COORDINATE_CONVENTIONS.astroSourceLoc, ...positionOf(source, "Shop") },
            },
          ]),
          tagName: "h1",
        }),
      };
    }
    case "preact": {
      const source = 'export function Card() {\n  return <section class="card">Hi</section>;\n}\n';
      const file = write("src/Card.tsx", source);
      return {
        path: "app/src/Card.tsx",
        edit: "\nexport const edited = true;\n",
        select: (elementId, candidateId) => ({
          ...observation(elementId, [
            {
              kind: "element-creation",
              candidateId,
              framework,
              extraction: { kind: "runtime-field", field: "__source" },
              file,
              location: {
                lineBase: 1,
                columnBase: 1,
                ...positionOf(source, '<section class="card"'),
              },
            },
          ]),
          tagName: "section",
        }),
      };
    }
  }
}

describe("ElementPickerHost", () => {
  it("round-trips a stub resolver through the host, which reads the bytes main served", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    expect(host.running).toBe(false);
    expect(children).toHaveLength(0);

    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-1", "app/src/App.svelte"),
          candidate("c-2", "app/src/Plain.svelte"),
        ]),
      ])
    );

    expect(children).toHaveLength(1);
    expect(results(response)).toEqual([
      {
        state: "verified",
        candidateId: "c-1",
        claim: "file-hint",
        target: { file: { workspaceId: id, path: "app/src/App.svelte" }, location: null },
        fileRevision: sha256(path.join(root, "app", "src", "App.svelte")),
      },
      {
        state: "unavailable",
        candidateId: "c-2",
        claim: "file-hint",
        reason: "mismatch",
        read: {
          file: { workspaceId: id, path: "app/src/Plain.svelte" },
          fileRevision: sha256(path.join(root, "app", "src", "Plain.svelte")),
        },
      },
    ]);
  });

  it("checks an Astro stamp against the file through the real host, placing the path the page reported", async () => {
    const page = path.join(root, "app", "src", "index.astro");
    fs.writeFileSync(page, "<main>\n  <h1>Shop</h1>\n</main>\n");
    const stamp = (candidateId: string, file: string, line: number, column: number) =>
      ({
        kind: "template-location",
        candidateId,
        framework: "astro",
        extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
        file,
        location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line, column },
      }) satisfies SourceCandidate;
    const { host } = harness(RESOLVER_LOADERS);
    const id = await workspace(host);
    const ref = { workspaceId: id, path: "app/src/index.astro" };

    const response = await host.resolve(
      request(id, [
        { ...observation("el-1", [stamp("c-1", page, 2, 7)]), tagName: "h1" },
        // `<main>` has children, so the compiler stamps its first child, not its name.
        { ...observation("el-2", [stamp("c-2", page, 1, 2)]), tagName: "main" },
        {
          ...observation("el-3", [
            stamp("c-3", path.join(root, "other", "Elsewhere.svelte"), 1, 4),
          ]),
          tagName: "p",
        },
      ])
    );

    expect(results(response)).toEqual([
      {
        state: "verified",
        candidateId: "c-1",
        claim: "template-location",
        target: { file: ref, location: stamp("c-1", page, 2, 7).location },
        fileRevision: sha256(page),
      },
      {
        state: "unavailable",
        candidateId: "c-2",
        claim: "template-location",
        reason: "mismatch",
        read: { file: ref, fileRevision: sha256(page) },
      },
      {
        state: "unavailable",
        candidateId: "c-3",
        claim: "template-location",
        reason: "outside-workspace",
      },
    ]);
  });

  it.each(["vue", "angular", "astro", "preact"] as const)(
    "resolves a %s selection through the registry, follows it across an edit, and calls a result held from before it stale",
    async (framework) => {
      const changes: SourceChange[] = [];
      const { host, watched } = harness(RESOLVER_LOADERS);
      const id = await workspace(host, (change) => changes.push(change));
      const app = writeFrameworkApp(framework, root);
      const file = path.join(root, app.path);
      const ref = { workspaceId: id, path: app.path };
      const verifiedAt = (revision: string) => [
        expect.objectContaining({
          state: "verified",
          candidateId: "c-1",
          target: expect.objectContaining({ file: ref }),
          fileRevision: revision,
        }),
      ];

      const before = sha256(file);
      expect(results(await host.resolve(request(id, [app.select("el-1", "c-1")])))).toEqual(
        verifiedAt(before)
      );

      fs.appendFileSync(file, app.edit);
      watched.get(path.dirname(file))!(file);
      const after = sha256(file);
      await vi.waitFor(() => expect(changes).toEqual([{ file: ref, revision: after }]));

      // The view marks what it held stale itself and proves the selection
      // again, holding nothing over: checked afresh against the edited bytes.
      expect(results(await host.resolve(request(id, [app.select("el-1", "c-1")])))).toEqual(
        verifiedAt(after)
      );
      // Asked about the earlier read instead, the resolver says it no longer holds.
      expect(
        results(
          await host.resolve({
            ...request(id, [app.select("el-1", "c-1")]),
            knownRevisions: [{ file: ref, revision: before }],
          })
        )
      ).toEqual([
        expect.objectContaining({
          state: "stale",
          reason: "file-changed",
          candidateId: "c-1",
          currentFileRevision: after,
        }),
      ]);
    }
  );

  it("resolves an Astro page and its Vue and Preact islands in one request, each by its own resolver", async () => {
    const { host, children } = harness(RESOLVER_LOADERS);
    const id = await workspace(host);
    const page = writeFrameworkApp("astro", root);
    const vue = writeFrameworkApp("vue", root);
    const preact = writeFrameworkApp("preact", root);

    const response = await host.resolve(
      request(id, [
        page.select("el-page", "c-page"),
        vue.select("el-vue", "c-vue"),
        preact.select("el-preact", "c-preact"),
      ])
    );

    expect(children).toHaveLength(1);
    expect(
      results(response).map((result) => [
        result.candidateId,
        result.state,
        result.state === "verified" ? result.target.file.path : null,
      ])
    ).toEqual([
      ["c-page", "verified", page.path],
      ["c-vue", "verified", vue.path],
      ["c-preact", "verified", preact.path],
    ]);
  });

  it("serves several worktrees at once from one host, each on its own framework and held to its own files", async () => {
    const { host, children } = harness(RESOLVER_LOADERS);
    const trees: Array<{ worktree: string; app: FrameworkApp; id: string }> = [];
    for (const framework of ["vue", "astro", "preact"] as const) {
      const worktree = path.join(root, `tree-${framework}`);
      const app = writeFrameworkApp(framework, worktree);
      const id = await host.registerWorkspace({
        worktreePath: worktree,
        appRoot: path.join(worktree, "app"),
        onSourceChanged: () => {},
      });
      trees.push({ worktree, app, id });
    }

    const responses = await Promise.all(
      trees.map(({ app, id }) => host.resolve(request(id, [app.select("el-1", "c-1")])))
    );

    expect(children).toHaveLength(1);
    expect(responses.map(results)).toEqual(
      trees.map(({ worktree, app, id }) => [
        expect.objectContaining({
          state: "verified",
          target: expect.objectContaining({ file: { workspaceId: id, path: app.path } }),
          fileRevision: sha256(path.join(worktree, app.path)),
        }),
      ])
    );

    // One tree's selection naming another tree's file reads nothing of it.
    const [vue, astro] = trees;
    const crossed = await host.resolve(request(vue!.id, [astro!.app.select("el-2", "c-2")]));
    expect(results(crossed)).toEqual([
      expect.objectContaining({ state: "unavailable", reason: "outside-workspace" }),
    ]);
  });

  it("refuses reads outside the app root without reading them", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-1", "other/Elsewhere.svelte"),
          candidate("c-2", "app/src/Missing.svelte"),
        ]),
      ])
    );
    expect(
      results(response).map((result) => result.state === "unavailable" && result.reason)
    ).toEqual(["outside-workspace", "file-missing"]);
  });

  it("starts one host for concurrent resolves and loads only the frameworks requested", async () => {
    const react = vi.fn(async () => stubResolver("react"));
    const { host, children } = harness({ svelte: async () => stubResolver(), react });
    const id = await workspace(host);
    const [first, second] = await Promise.all([
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])),
      host.resolve(
        request(id, [observation("el-2", [candidate("c-2", "app/src/App.svelte", "vue")])])
      ),
    ]);
    expect(children).toHaveLength(1);
    expect(results(first)[0]?.state).toBe("verified");
    expect(results(second)).toEqual([
      { state: "unavailable", candidateId: "c-2", claim: "file-hint", reason: "unsupported" },
    ]);
    expect(react).not.toHaveBeenCalled();
  });

  describe("plugin providers", () => {
    afterEach(() => unregisterElementPickerProviders("acme.qwik"));

    const qwikRequest = (id: string) =>
      request(id, [
        observation("el-1", [candidate("c-1", "app/src/App.svelte", "acme.qwik.qwik")]),
      ]);

    it("refuses a request naming a provider no enabled plugin registered", async () => {
      const { host } = harness();
      const id = await workspace(host);
      expect(await failure(host.resolve(qwikRequest(id), { projectId: "p1" }))).toMatchObject({
        code: "INVALID_REQUEST",
      });
    });

    it("answers a provider that declared no resolver as unsupported, without starting a host", async () => {
      registerElementPickerProviders("acme.qwik", "acme.qwik", [
        {
          id: "qwik",
          name: "Qwik",
          detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
          guestEntry: "guest/qwik.js",
        },
      ]);
      const { host, children } = harness();
      const id = await workspace(host);
      const response = await host.resolve(qwikRequest(id), { projectId: "p1" });
      expect(results(response)).toEqual([
        { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "unsupported" },
      ]);
      expect(children).toHaveLength(0);
      expect(host.pluginHosts).toBe(0);
    });

    it("refuses the provider again once its plugin is unloaded", async () => {
      registerElementPickerProviders("acme.qwik", "acme.qwik", [
        {
          id: "qwik",
          name: "Qwik",
          detection: [{ kind: "global", name: "q", match: "exact" }],
          guestEntry: "g.js",
        },
      ]);
      unregisterElementPickerProviders("acme.qwik");
      const { host } = harness();
      const id = await workspace(host);
      expect(await failure(host.resolve(qwikRequest(id)))).toMatchObject({
        code: "INVALID_REQUEST",
      });
    });
  });

  it("retires an idle host and forks a fresh one for the next resolve", async () => {
    const { host, children } = harness(undefined, { idleMs: 20 });
    const id = await workspace(host);
    const ask = () =>
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]));

    await ask();
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
    expect(children[0]?.posted).toContain("dispose");
    expect(host.running).toBe(false);

    const again = await ask();
    expect(children).toHaveLength(2);
    expect(results(again)[0]?.state).toBe("verified");
  });

  it("fails the jobs a crashed host held and recovers on the next resolve", async () => {
    let generation = 0;
    const { host, children } = harness(() => {
      generation += 1;
      return generation === 1
        ? { svelte: async () => stallingResolver(false) }
        : { svelte: async () => stubResolver() };
    });
    const id = await workspace(host);
    const ask = () =>
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]));

    const stuck = failure(ask());
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    children[0]!.exit(1);
    expect(await stuck).toMatchObject({ code: "HOST_CRASHED" });
    expect(host.running).toBe(false);

    const recovered = await ask();
    expect(children).toHaveLength(2);
    expect(results(recovered)[0]?.state).toBe("verified");
  });

  it("fails a host that exits before it is ready with HOST_START_FAILED", async () => {
    const { host, children } = harness(undefined, { child: { start: false } });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(1);
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
  });

  it("retires a host that never becomes ready, killing it once the backstop lapses", async () => {
    const { host, children, kill } = harness(undefined, {
      child: { ready: false, ignoreDispose: true },
      startTimeoutMs: 20,
      disposeKillMs: 20,
    });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
    expect(host.running).toBe(false);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(children[0]!.pid));
    expect(children[0]?.alive).toBe(false);
  });

  it("kills a retired host that had no pid yet as soon as it spawns", async () => {
    const { host, children, kill } = harness(undefined, {
      child: { start: false, ignoreDispose: true },
      startTimeoutMs: 10,
      disposeKillMs: 10,
    });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kill).not.toHaveBeenCalled();
    children[0]!.start();
    expect(kill).toHaveBeenCalledWith(children[0]!.pid);
  });

  // The deadline runs from admission, so each window below is wide enough for
  // a cold start, and each test proves the resolver was reached before it.
  it("answers budget-exhausted at the deadline and retires a host that ignores the cancel", async () => {
    let entered = false;
    const { host, children } = harness(
      { svelte: async () => stallingResolver(false, () => (entered = true)) },
      { cancelGraceMs: 20 }
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 600,
      })
    );
    expect(entered).toBe(true);
    expect(results(response)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "budget-exhausted" },
    ]);
    expect(children[0]?.posted).toContain("cancel");
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
  });

  it("reports a cooperative resolver stopped by the deadline as out of budget, not cancelled", async () => {
    let entered = false;
    const { host, children } = harness({
      svelte: async () => stallingResolver(true, () => (entered = true)),
    });
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 600,
      })
    );
    expect(entered).toBe(true);
    expect(results(response)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "budget-exhausted" },
    ]);
    // The grace fallback retires the host as it settles; still running means
    // the resolver's own answer is what came back.
    expect(host.running).toBe(true);
    expect(children[0]?.alive).toBe(true);
  });

  it("keeps a cancel a cancel when the deadline passes before the resolver answers it", async () => {
    let entered = false;
    // Honours the cancel, but only answers once the deadline has also passed.
    const slow: HostSourceResolver = {
      framework: "svelte",
      resolve: (req, _access, signal) =>
        new Promise((resolve) => {
          entered = true;
          signal.addEventListener("abort", () =>
            setTimeout(
              () =>
                resolve({
                  requestId: req.requestId,
                  documentEpoch: req.documentEpoch,
                  outcomes: [],
                }),
              1_200
            )
          );
        }),
    };
    const { host } = harness({ svelte: async () => slow }, { cancelGraceMs: 3_000 });
    const id = await workspace(host);
    const controller = new AbortController();
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 1_000,
      }),
      { signal: controller.signal }
    );
    // Cancelled as soon as it starts, answered only after the deadline has passed.
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    expect(results(await pending)[0]).toMatchObject({ reason: "cancelled" });
    expect(host.running).toBe(true);
  });

  it("keeps a host that answers a cancel, with every unanswered candidate cancelled", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(true) });
    const id = await workspace(host);
    const controller = new AbortController();
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]),
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    controller.abort();
    expect(results(await pending)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "cancelled" },
    ]);
    expect(children[0]?.alive).toBe(true);
    expect(host.running).toBe(true);
  });

  it("cancels a resolve whose workspace is released", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(true) });
    const id = await workspace(host);
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    expect(host.releaseWorkspace(id)).toBe(true);
    expect(results(await pending)[0]).toMatchObject({ reason: "cancelled" });
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
  });

  it("rejects a resolver's answer that names another workspace's file", async () => {
    const forger: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "observed",
                candidateId: "c-1",
                claim: "file-hint",
                target: { file: { workspaceId: "elsewhere", path: "x.svelte" }, location: null },
                fileRevision: null,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => forger });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    expect(host.running).toBe(true);
  });

  it("rejects a resolver's answer that claims a revision main never served", async () => {
    const liar: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "verified",
                candidateId: "c-1",
                claim: "file-hint",
                target: {
                  file: { workspaceId: req.workspaceId, path: "app/src/App.svelte" },
                  location: null,
                },
                fileRevision: `sha256:${"0".repeat(64)}`,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => liar });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });

  it("holds a component's definition to the same authority as the call site that names it", async () => {
    const served = sha256(path.join(root, "app", "src", "App.svelte"));
    const naming = (definition: { path: string; fileRevision: string }): HostSourceResolver => ({
      framework: "svelte",
      resolve: async (req, access, signal) => {
        const file = { workspaceId: req.workspaceId, path: "app/src/App.svelte" };
        await access.readSource(file, signal);
        await access.readSource(
          { workspaceId: req.workspaceId, path: "app/src/Plain.svelte" },
          signal
        );
        return {
          requestId: req.requestId,
          documentEpoch: req.documentEpoch,
          outcomes: [
            {
              elementId: "el-1",
              results: [
                {
                  state: "verified",
                  candidateId: "c-1",
                  claim: "component-invocation",
                  target: { file, location: null },
                  fileRevision: served,
                  definition: {
                    file: { workspaceId: req.workspaceId, path: definition.path },
                    fileRevision: definition.fileRevision,
                    specifier: "./Plain.svelte",
                  },
                },
              ],
            },
          ],
        };
      },
    });
    const ask = async (resolver: HostSourceResolver) => {
      const { host } = harness({ svelte: async () => resolver });
      const id = await workspace(host);
      const invocation = {
        ...candidate("c-1", "app/src/App.svelte"),
        kind: "component-invocation",
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 1, column: 0 },
      } as const;
      return host.resolve(request(id, [observation("el-1", [], [invocation])]));
    };
    const plain = sha256(path.join(root, "app", "src", "Plain.svelte"));

    await expect(
      ask(naming({ path: "app/src/Plain.svelte", fileRevision: plain }))
    ).resolves.toMatchObject({
      outcomes: [{ results: [{ definition: { fileRevision: plain } }] }],
    });
    await expect(
      ask(naming({ path: "app/src/Plain.svelte", fileRevision: `sha256:${"0".repeat(64)}` }))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    await expect(
      ask(naming({ path: "other/Elsewhere.svelte", fileRevision: plain }))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });

  it("rejects a resolver's answer that names a file outside the app", async () => {
    const wanderer: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "observed",
                candidateId: "c-1",
                claim: "file-hint",
                target: {
                  file: { workspaceId: req.workspaceId, path: "other/Elsewhere.svelte" },
                  location: null,
                },
                fileRevision: null,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => wanderer });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });

  it("answers a selection the page traced to no source without starting the host", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    // A component the page could name but not place: a chain, and nothing to read.
    const untraced: SelectionObservation = {
      ...observation("el-1", []),
      componentChain: {
        nearestId: "vue-1",
        components: [
          {
            componentId: "vue-1",
            framework: "vue",
            name: null,
            environment: "client",
            rootElementIds: ["el-1"],
            rootsComplete: true,
            sourceCandidates: [],
          },
        ],
        truncated: false,
      },
    };
    const asked = request(id, [untraced, observation("el-2", [])]);

    expect(await host.resolve(asked)).toEqual({
      requestId: asked.requestId,
      documentEpoch: asked.documentEpoch,
      outcomes: [
        { elementId: "el-1", results: [] },
        { elementId: "el-2", results: [] },
      ],
    });
    expect(children).toHaveLength(0);
    expect(host.running).toBe(false);
    // Still a request about an open workspace, checked as any other.
    const released = await workspace(host);
    host.releaseWorkspace(released);
    await expect(host.resolve(request(released, [untraced]))).rejects.toMatchObject({
      code: "UNKNOWN_WORKSPACE",
    });

    // The first selection with something to read is what starts it.
    await host.resolve(
      request(id, [untraced, observation("el-2", [candidate("c-1", "app/src/App.svelte")])])
    );
    expect(children).toHaveLength(1);
  });

  it("refuses a request whose observations share an element id, before forking", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    await expect(
      host.resolve(
        request(id, [
          observation("el-1", [candidate("c-1", "app/src/App.svelte")]),
          observation("el-1", [candidate("c-2", "app/src/App.svelte")]),
        ])
      )
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(children).toHaveLength(0);
  });

  it("retires a host that sends a malformed message", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(false) });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    children[0]!.deliver({ type: "resolved", jobId: "not-a-number" });
    expect(await pending).toMatchObject({ code: "HOST_CRASHED" });
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
  });

  it("tracks what a resolve read and reports a real change without waking the host", async () => {
    const changes: SourceChange[] = [];
    const { host, children, watched } = harness(undefined, { idleMs: 20 });
    const id = await workspace(host, (change) => changes.push(change));
    const file = path.join(root, "app", "src", "App.svelte");
    await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    await vi.waitFor(() => expect(host.running).toBe(false));

    const onChange = watched.get(path.dirname(file));
    expect(onChange).toBeDefined();
    // An event for unchanged content first: the single push below proves it added none.
    onChange!(file);
    fs.writeFileSync(file, `<h2>${STUB_MARKER}</h2>`);
    onChange!(file);
    await vi.waitFor(() =>
      expect(changes).toEqual([
        { file: { workspaceId: id, path: "app/src/App.svelte" }, revision: sha256(file) },
      ])
    );
    expect(children).toHaveLength(1);
  });

  it("fails in-flight work on dispose and never forks again", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(false) });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    await host.dispose();
    expect(await pending).toMatchObject({ code: "HOST_DISPOSED" });
    expect(children[0]?.alive).toBe(false);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "HOST_DISPOSED" });
    expect(children).toHaveLength(1);
  });

  it("maps a frame through a map main served, and rejects an answer citing one it did not", async () => {
    const module = "http://localhost:5173/src/App.svelte?t=1";
    const content = fs.readFileSync(path.join(root, "app", "src", "App.svelte"), "utf8");
    const text = JSON.stringify({
      version: 3,
      sources: ["App.svelte"],
      names: [],
      mappings: "AAAA",
      sourcesContent: [content],
    });
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl, allowance }) => {
      allowance.request();
      return {
        ok: true,
        value: {
          url: null,
          base: generatedUrl,
          revision: revisionOf(new TextEncoder().encode(text)),
          text,
        },
      };
    });
    const frame: Extract<SourceCandidate, { kind: "element-creation" }> = {
      kind: "element-creation",
      candidateId: "c-1",
      framework: "svelte",
      extraction: { kind: "generated-stack-frame", field: "stack", frameIndex: 0 },
      file: module,
      location: { ...COORDINATE_CONVENTIONS.v8StackFrame, columnUnit: "utf16", line: 1, column: 1 },
    };
    type Variant = "mapped" | "ambiguous" | "forged-url" | "forged-revision" | "forged-alternative";
    const mapper = (variant: Variant): HostSourceResolver => ({
      framework: "svelte",
      resolve: async (req, access, signal) => {
        const symbolication = await createSourceMapSymbolicator(access).symbolicate(
          { url: frame.file, location: frame.location },
          signal
        );
        const mapped = symbolicatedResult(frame, symbolication);
        if (mapped.state !== "mapped") throw new Error(`expected a mapping, got ${mapped.state}`);
        const { candidateId, claim, ...held } = mapped;
        const forged = {
          ...held,
          sourceMap: { ...held.sourceMap, mapUrl: "http://localhost:5173/forged.map" },
        };
        const answers: Record<Variant, ResolutionResult> = {
          mapped,
          ambiguous: { state: "ambiguous", candidateId, claim, alternatives: [held, held] },
          "forged-url": { ...mapped, sourceMap: forged.sourceMap },
          "forged-revision": {
            ...mapped,
            sourceMap: { ...held.sourceMap, mapRevision: `sha256:${"0".repeat(64)}` },
          },
          "forged-alternative": {
            state: "ambiguous",
            candidateId,
            claim,
            alternatives: [held, forged],
          },
        };
        return {
          requestId: req.requestId,
          documentEpoch: req.documentEpoch,
          outcomes: [{ elementId: "el-1", results: [answers[variant]] }],
        };
      },
    });
    for (const variant of [
      "mapped",
      "ambiguous",
      "forged-url",
      "forged-revision",
      "forged-alternative",
    ] as const) {
      const { host } = harness({ svelte: async () => mapper(variant) }, { sourceMaps });
      const id = await host.registerWorkspace({
        worktreePath: root,
        appRoot: path.join(root, "app"),
        previewOrigin: "http://localhost:5173/some/page",
        onSourceChanged: () => {},
      });
      const resolving = host.resolve(request(id, [observation("el-1", [frame])]));
      if (variant.startsWith("forged")) {
        await expect(resolving, variant).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
        continue;
      }
      const [result] = results(await resolving);
      expect(result?.state, variant).toBe(variant);
      if (variant !== "mapped") continue;
      expect(result).toMatchObject({
        target: { file: { workspaceId: id, path: "app/src/App.svelte" } },
        fileRevision: sha256(path.join(root, "app", "src", "App.svelte")),
        sourceMap: { mapUrl: null, sourceCheck: "matches" },
      });
      expect(sourceMaps).toHaveBeenLastCalledWith(
        expect.objectContaining({ previewOrigin: "http://localhost:5173", generatedUrl: module }),
        expect.anything()
      );
    }
  });

  it("fetches no map for a workspace registered without a preview origin", async () => {
    const sourceMaps = vi.fn<SourceMapProvider>();
    const fetched: unknown[] = [];
    const { host } = harness(
      {
        svelte: async () => ({
          framework: "svelte",
          resolve: async (req, access, signal) => {
            fetched.push(await access.fetchSourceMap("http://localhost:5173/a.js", signal));
            return { requestId: req.requestId, documentEpoch: req.documentEpoch, outcomes: [] };
          },
        }),
      },
      { sourceMaps }
    );
    const id = await workspace(host);
    await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    expect(fetched).toEqual([{ ok: false, reason: "unsupported" }]);
    expect(sourceMaps).not.toHaveBeenCalled();
  });

  it("refuses a preview origin that is not a plain HTTP(S) origin", async () => {
    const { host } = harness();
    for (const previewOrigin of ["not a url", "file:///srv/app", "http://user:pw@localhost:5173"]) {
      await expect(
        host.registerWorkspace({ worktreePath: root, previewOrigin, onSourceChanged: () => {} }),
        previewOrigin
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("refuses a malformed request and an app root outside the worktree", async () => {
    const { host } = harness();
    await expect(host.resolve({ requestId: "r" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      host.registerWorkspace({
        worktreePath: path.join(root, "app"),
        appRoot: path.join(root, "other"),
        onSourceChanged: () => {},
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("ElementPickerHost project context", () => {
  const kitManifest = JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } });

  function adapters(
    describe: ProjectAdapter["describe"],
    detects: ProjectAdapterRegistration["detects"] = () => true
  ): ProjectAdapterRegistration[] {
    return [{ id: "sveltekit", detects, load: async () => ({ describe }) }];
  }

  it("answers a selection while a project adapter hangs", async () => {
    fs.writeFileSync(path.join(root, "app", "package.json"), kitManifest);
    let entered!: () => void;
    const adapterRunning = new Promise<void>((resolve) => (entered = resolve));
    const { host } = harness(undefined, {
      projectAdapters: adapters(() => {
        entered();
        return new Promise<never>(() => {});
      }),
      // Far off: nothing but the workspace closing ends this context request.
      projectContextDeadlineMs: 60_000,
    });
    const id = await workspace(host);
    let contextSettled = false;
    const context = host.describeProject(id, "http://localhost:5173/blog").finally(() => {
      contextSettled = true;
    });
    // The adapter is inside its walk, holding a context slot, before the selection arrives.
    await adapterRunning;

    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );

    expect(results(response)[0]).toMatchObject({ state: "verified", candidateId: "c-1" });
    expect(contextSettled).toBe(false);
    host.releaseWorkspace(id);
    await expect(context).resolves.toEqual({ status: "unavailable", reason: "cancelled" });
  });

  it("reads context without starting the resolver process, and a resolve never consults it", async () => {
    fs.writeFileSync(path.join(root, "app", "package.json"), kitManifest);
    const detects = vi.fn(() => true);
    const { host, children } = harness(undefined, {
      projectAdapters: adapters(async () => {
        throw new Error("route parser exploded");
      }, detects),
    });
    const id = await workspace(host);

    await expect(host.describeProject(id, "http://localhost/")).resolves.toEqual({
      status: "unavailable",
      reason: "failed",
    });
    expect(host.running).toBe(false);
    expect(children).toHaveLength(0);

    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    expect(results(response)[0]).toMatchObject({ state: "verified" });
    expect(detects).toHaveBeenCalledTimes(1);
  });

  it("reads each workspace's own app, so one app's failure leaves another's context alone", async () => {
    fs.writeFileSync(path.join(root, "app", "package.json"), kitManifest);
    fs.writeFileSync(path.join(root, "other", "package.json"), kitManifest);
    const seen: string[] = [];
    const { host } = harness(undefined, {
      projectAdapters: adapters(async ({ roots }) => {
        seen.push(path.relative(root, roots.appRoot));
        if (roots.appRoot.endsWith("other")) throw new Error("unreadable tree");
        return {
          adapter: "sveltekit",
          appPath: "app",
          route: null,
          routes: { directory: "app/src/routes", source: "default", basePath: "", complete: true },
          toolchain: {
            versions: { svelte: "5.0.0", kit: "2.0.0", tailwind: null, vite: null },
            verdict: "tested",
            reasons: [],
            missingInstall: [],
          },
          diagnostics: [],
        };
      }),
    });
    const app = await workspace(host);
    const other = await host.registerWorkspace({
      worktreePath: root,
      appRoot: path.join(root, "other"),
      onSourceChanged: () => {},
    });

    const [otherOutcome, appOutcome] = await Promise.all([
      host.describeProject(other, "http://localhost/"),
      host.describeProject(app, "http://localhost/"),
    ]);

    expect(otherOutcome).toEqual({ status: "unavailable", reason: "failed" });
    expect(appOutcome).toMatchObject({ status: "described", context: { appPath: "app" } });
    expect(seen.sort()).toEqual(["app", "other"]);
  });

  it("answers an unknown or released workspace, and a disposed host, without rejecting", async () => {
    fs.writeFileSync(path.join(root, "app", "package.json"), kitManifest);
    const { host } = harness(undefined, {
      projectAdapters: adapters(() => new Promise<never>(() => {})),
    });
    const id = await workspace(host);

    await expect(host.describeProject("nope", "http://localhost/")).resolves.toEqual({
      status: "unavailable",
      reason: "unknown-workspace",
    });
    const pending = host.describeProject(id, "http://localhost/");
    expect(host.releaseWorkspace(id)).toBe(true);
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "cancelled" });
    await host.dispose();
    await expect(host.describeProject(id, "http://localhost/")).resolves.toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
  });
});

describe("ElementPickerHost held sources", () => {
  it("takes the view's list without reading anything or starting the host", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    await expect(host.holdSources(id, ["app/src/App.svelte", "app/src/Missing.svelte"])).resolves.toBeUndefined();
    await expect(host.holdSources(id, [])).resolves.toBeUndefined();
    expect(children).toHaveLength(0);
    expect(host.running).toBe(false);
  });

  it("refuses a list past its bound or holding anything but paths", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const tooMany = Array.from(
      { length: ELEMENT_PICKER_MAX_HELD_SOURCES + 1 },
      (_, index) => `app/src/F${index}.svelte`
    );
    await expect(host.holdSources(id, tooMany)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      host.holdSources(id, ["app/src/App.svelte", 7] as unknown as string[])
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      host.holdSources(id, tooMany.slice(0, ELEMENT_PICKER_MAX_HELD_SOURCES))
    ).resolves.toBeUndefined();
  });

  it("refuses an unknown or released workspace, and anything once disposed", async () => {
    const { host } = harness();
    const id = await workspace(host);
    await expect(host.holdSources("nope", [])).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
    host.releaseWorkspace(id);
    await expect(host.holdSources(id, [])).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
    await host.dispose();
    await expect(host.holdSources(id, [])).rejects.toMatchObject({ code: "HOST_DISPOSED" });
  });
});

describe("ElementPickerHost source revisions", () => {
  it("answers what each file holds now, read in main without starting the host", async () => {
    const { host, children } = harness();
    const id = await workspace(host);

    const revisions = await host.sourceRevisions(id, [
      "app/src/App.svelte",
      "app/src/Plain.svelte",
    ]);

    expect(revisions).toEqual([
      { path: "app/src/App.svelte", revision: sha256(path.join(root, "app", "src", "App.svelte")) },
      {
        path: "app/src/Plain.svelte",
        revision: sha256(path.join(root, "app", "src", "Plain.svelte")),
      },
    ]);
    expect(children).toHaveLength(0);
    expect(host.running).toBe(false);
  });

  it("answers null for a file it may not read or cannot, without refusing the rest", async () => {
    const { host } = harness();
    const id = await workspace(host);
    fs.symlinkSync(
      path.join(root, "other", "Elsewhere.svelte"),
      path.join(root, "app", "src", "Escape.svelte")
    );
    fs.writeFileSync(
      path.join(root, "app", "src", "Huge.svelte"),
      Buffer.alloc(RESOLVE_BUDGET_CEILINGS.maxFileBytes + 1, 0x61)
    );
    fs.mkdirSync(path.join(root, "app", "src", "Folder.svelte"));
    const refused = [
      // Inside the worktree, outside the app the workspace is held to.
      "other/Elsewhere.svelte",
      // Inside the app, through a link that leads out of it.
      "app/src/Escape.svelte",
      "app/src/Missing.svelte",
      "app/src/Huge.svelte",
      "app/src/Folder.svelte",
      // Not workspace-relative refs at all.
      "../outside.svelte",
      "app/../other/Elsewhere.svelte",
      "app/./src/App.svelte",
      path.join(root, "app", "src", "App.svelte"),
      "app\\src\\App.svelte",
      "",
    ];

    const revisions = await host.sourceRevisions(id, [...refused, "app/src/App.svelte"]);

    expect(revisions.filter((entry) => entry.revision !== null).map((entry) => entry.path)).toEqual(
      ["app/src/App.svelte"]
    );
    expect(revisions.map((entry) => entry.path)).toEqual([...refused, "app/src/App.svelte"]);
  });

  it("reads each path once, answering in the order it was first named", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const revisions = await host.sourceRevisions(id, [
      "app/src/Plain.svelte",
      "app/src/App.svelte",
      "app/src/Plain.svelte",
    ]);
    expect(revisions.map((entry) => entry.path)).toEqual([
      "app/src/Plain.svelte",
      "app/src/App.svelte",
    ]);
  });

  it("refuses a list past its bound or holding anything but paths", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const tooMany = Array.from(
      { length: MAX_SOURCE_REVISION_PATHS + 1 },
      (_, index) => `app/src/F${index}.svelte`
    );
    await expect(host.sourceRevisions(id, tooMany)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      host.sourceRevisions(id, ["app/src/App.svelte", 7] as unknown as string[])
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      host.sourceRevisions(id, tooMany.slice(0, MAX_SOURCE_REVISION_PATHS))
    ).resolves.toHaveLength(MAX_SOURCE_REVISION_PATHS);
  });

  it("refuses an unknown or released workspace, and answers nothing once disposed", async () => {
    const { host } = harness();
    const id = await workspace(host);
    await expect(host.sourceRevisions("nope", ["app/src/App.svelte"])).rejects.toMatchObject({
      code: "UNKNOWN_WORKSPACE",
    });
    host.releaseWorkspace(id);
    await expect(host.sourceRevisions(id, ["app/src/App.svelte"])).rejects.toMatchObject({
      code: "UNKNOWN_WORKSPACE",
    });
    await host.dispose();
    await expect(host.sourceRevisions(id, ["app/src/App.svelte"])).rejects.toMatchObject({
      code: "HOST_DISPOSED",
    });
  });

  it("answers nothing for a workspace released while it was reading", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const pending = host.sourceRevisions(id, ["app/src/App.svelte", "app/src/Plain.svelte"]);
    host.releaseWorkspace(id);
    await expect(pending).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
  });
});
