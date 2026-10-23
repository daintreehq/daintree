import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { ElementPickerHost, MAX_PLUGIN_HOSTS } from "../ElementPickerHost.js";
// Loaded up front: the host imports it on a plugin's first resolve, and a module
// load needs more real time than a test's waits give a fake child.
import "../pluginResolverAssets.js";
import type {
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import { observationCandidates, unavailableResult } from "../outcomes.js";
import { buildFixtureResolverEntry } from "./buildFixtureGuestEntry.js";
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
import type { ResolverLoaders } from "../worker/runtime.js";

/** Real file I/O runs before a dispatch reaches its host, so waits get real time. */
const WAIT = { timeout: 5_000 };

/**
 * Plugin source resolvers, each plugin in a host of its own: the real
 * `ElementPickerHost`, the real plugin runtime behind a stand-in process, and
 * entries read from installed plugin directories the way the registry records
 * them. The Lit fixture's entry is built and imported for real.
 */

const FIXTURE = "electron/services/elementPicker/__tests__/fixtures/plugins/lit-picker";
const LIT_PLUGIN = "fixture.lit-picker";
const LIT_PROVIDER = "fixture.lit-picker.lit";
const CARD_FILE = "src/card.ts";
const CARD = [
  'import { html } from "lit";',
  "",
  "export const card = () => html`",
  '  <fixture-lit-card heading="Hi"></fixture-lit-card>',
  "`;",
  "",
].join("\n");

let litEntry = "";
let root: string;
const hosts: ElementPickerHost[] = [];
const tempDirs: string[] = [];
const plugins: string[] = [];

beforeAll(() => {
  litEntry = buildFixtureResolverEntry(`${FIXTURE}/src/resolver.ts`);
}, 60_000);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picker-plugin-")));
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", CARD_FILE), CARD);
  fs.writeFileSync(path.join(root, "app", "src", "App.svelte"), `<h1>${STUB_MARKER}</h1>`);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const plugin of plugins.splice(0)) unregisterElementPickerProviders(plugin);
  fs.rmSync(root, { recursive: true, force: true });
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Installs a plugin with one provider whose resolver entry holds `entry`, and registers it. */
function installPlugin(
  pluginId: string,
  entry: string | null,
  contributionId = "p"
): { dir: string; url: string; providerId: string } {
  const resolverEntry = "dist/picker/resolver.mjs";
  const dir = tempDir("picker-plugin-install-");
  if (entry !== null) {
    const file = path.join(dir, ...resolverEntry.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry);
  }
  registerElementPickerProviders(
    pluginId,
    pluginId,
    [
      {
        id: contributionId,
        name: pluginId,
        detection: [{ kind: "global", name: pluginId, match: "exact" }],
        guestEntry: "dist/picker/guest.js",
        resolverEntry,
      },
    ],
    dir
  );
  plugins.push(pluginId);
  return {
    dir,
    url: pathToFileURL(path.join(dir, ...resolverEntry.split("/"))).href,
    providerId: `${pluginId}.${contributionId}`,
  };
}

interface Harness {
  host: ElementPickerHost;
  core: RuntimeChild[];
  plugin: Array<{ pluginId: string; child: RuntimeChild }>;
  /** Plugin hosts alive at once, at the most. */
  peak(): number;
}

function harness(
  modules: Map<string, unknown>,
  options: ConstructorParameters<typeof ElementPickerHost>[0] & {
    coreLoaders?: ResolverLoaders;
    pluginChild?: RuntimeChildOptions;
  } = {}
): Harness {
  const { coreLoaders, pluginChild, ...hostOptions } = options;
  const core: RuntimeChild[] = [];
  const plugin: Array<{ pluginId: string; child: RuntimeChild }> = [];
  let peak = 0;
  const host = new ElementPickerHost({
    fork: () => {
      const child = new RuntimeChild(coreLoaders ?? { svelte: async () => stubResolver() });
      core.push(child);
      return child;
    },
    pluginFork: (pluginId) => {
      const child = new RuntimeChild(
        {
          importModule: async (url) => {
            if (modules.has(url)) return modules.get(url);
            return import(/* @vite-ignore */ url);
          },
        },
        pluginChild
      );
      plugin.push({ pluginId, child });
      peak = Math.max(peak, plugin.filter((entry) => entry.child.alive).length);
      return child;
    },
    kill: (pid) => {
      for (const child of [...core, ...plugin.map((entry) => entry.child)]) {
        if (child.pid === pid) child.exit(9);
      }
    },
    watch: () => () => {},
    idleMs: 60_000,
    ...hostOptions,
  });
  hosts.push(host);
  return { host, core, plugin, peak: () => peak };
}

async function workspace(host: ElementPickerHost): Promise<string> {
  return host.registerWorkspace({
    worktreePath: root,
    appRoot: path.join(root, "app"),
    onSourceChanged: () => {},
  });
}

function sha256(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function results(response: ResolveResponse) {
  return response.outcomes.flatMap((outcome) => outcome.results);
}

function litCandidate(line: number, column: number): SourceCandidate {
  return {
    kind: "template-location",
    candidateId: "lit-source",
    framework: LIT_PROVIDER,
    extraction: { kind: "attribute", attribute: "data-fixture-lit-source" },
    file: CARD_FILE,
    location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line, column },
  };
}

function litObservation(elementId: string, line: number, column: number): SelectionObservation {
  return {
    ...observation(elementId, [litCandidate(line, column)]),
    tagName: "fixture-lit-card",
    frameworkEvidence: [
      {
        kind: "generic",
        framework: LIT_PROVIDER,
        fields: [{ name: "tag", value: "fixture-lit-card" }],
      },
    ],
  };
}

/** A module whose default export is a factory, as `defineElementPickerResolver` marks one. */
function moduleOf(
  resolve: (
    request: ResolveRequest,
    access: ResolverSourceAccess,
    signal: AbortSignal
  ) => Promise<ResolveResponse>
): unknown {
  return { default: () => ({ resolve }) };
}

/** Claims every candidate it was sent as a file the stub marker is in. */
function markerModule(): unknown {
  const stub = stubResolver();
  return moduleOf((request, access, signal) => stub.resolve(request, access, signal));
}

/** Never answers until cancelled; then answers nothing. */
function stallingModule(onEnter?: () => void): unknown {
  return moduleOf(
    (request, _access, signal) =>
      new Promise((resolve) => {
        onEnter?.();
        signal.addEventListener("abort", () =>
          resolve({
            requestId: request.requestId,
            documentEpoch: request.documentEpoch,
            outcomes: [],
          })
        );
      })
  );
}

describe("plugin source resolvers", () => {
  it("verifies the Lit fixture's stamp against the bytes main served, in the plugin's own host", async () => {
    const { url } = installPlugin(LIT_PLUGIN, litEntry, "lit");
    expect(url.endsWith("resolver.mjs")).toBe(true);
    // The fixture's own manifest names the same entry this installs.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../..", FIXTURE, "plugin.json"), "utf8")
    ) as {
      capabilities: string[];
      contributes: { elementPickerProviders: Array<{ resolverEntry: string }> };
    };
    expect(manifest.capabilities).toContain("fs:project-read");
    expect(manifest.contributes.elementPickerProviders[0]?.resolverEntry).toBe(
      "dist/picker/resolver.mjs"
    );

    const { host, core, plugin } = harness(new Map());
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [litObservation("el-1", 4, 3), litObservation("el-2", 2, 1)]),
      { projectId: "p1" }
    );
    const file = { workspaceId: id, path: `app/${CARD_FILE}` };
    const revision = sha256(path.join(root, "app", CARD_FILE));
    expect(results(response)).toEqual([
      {
        state: "verified",
        candidateId: "lit-source",
        claim: "template-location",
        target: {
          file,
          location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line: 4, column: 3 },
        },
        fileRevision: revision,
      },
      {
        state: "unavailable",
        candidateId: "lit-source",
        claim: "template-location",
        reason: "mismatch",
        read: { file, fileRevision: revision },
      },
    ]);
    expect(core).toHaveLength(0);
    expect(plugin.map((entry) => entry.pluginId)).toEqual([LIT_PLUGIN]);
    // Told where its resolver is before the job that needs it; every read after is main's answer.
    expect(plugin[0]!.child.posted.slice(0, 2)).toEqual(["provider", "resolve"]);
    expect(new Set(plugin[0]!.child.posted.slice(2))).toEqual(new Set(["access-result"]));
  });

  it("answers core and plugin candidates in one selection, each from its own process", async () => {
    installPlugin(LIT_PLUGIN, litEntry, "lit");
    const { host, core, plugin } = harness(new Map());
    const id = await workspace(host);
    const lit = litObservation("el-1", 4, 3);
    const mixed = observation("el-2", [candidate("c-svelte", "app/src/App.svelte")]);
    const response = await host.resolve(request(id, [mixed, lit]), { projectId: "p1" });
    expect(response.outcomes.map((outcome) => outcome.elementId)).toEqual(["el-2", "el-1"]);
    expect(results(response).map((result) => [result.candidateId, result.state])).toEqual([
      ["c-svelte", "verified"],
      ["lit-source", "verified"],
    ]);
    expect(core).toHaveLength(1);
    expect(plugin).toHaveLength(1);
  });

  it("starts nothing for a provider that declared no resolver", async () => {
    registerElementPickerProviders("acme.qwik", "acme.qwik", [
      {
        id: "qwik",
        name: "Qwik",
        detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
        guestEntry: "guest/qwik.js",
      },
    ]);
    plugins.push("acme.qwik");
    const { host, core, plugin } = harness(new Map());
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [candidate("c-1", "app/src/App.svelte", "acme.qwik.qwik")]),
      ]),
      { projectId: "p1" }
    );
    expect(results(response)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "unsupported" },
    ]);
    expect(core).toHaveLength(0);
    expect(plugin).toHaveLength(0);
    expect(host.pluginHosts).toBe(0);
  });

  it("shares one host across a plugin's workspaces and retires it when idle", async () => {
    const { url, providerId } = installPlugin("acme.one", "export {}");
    const { host, plugin } = harness(new Map([[url, markerModule()]]), { idleMs: 30 });
    const first = await workspace(host);
    const second = await workspace(host);
    const ask = (workspaceId: string) =>
      host.resolve(
        request(workspaceId, [
          observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)]),
        ]),
        { projectId: "p1" }
      );

    const [a, b] = await Promise.all([ask(first), ask(second)]);
    expect(results(a)[0]?.state).toBe("verified");
    expect(results(b)[0]?.state).toBe("verified");
    expect(plugin).toHaveLength(1);
    // Told about its provider once, however many jobs name it.
    expect(plugin[0]!.child.posted.filter((type) => type === "provider")).toHaveLength(1);

    await vi.waitFor(() => expect(plugin[0]!.child.alive).toBe(false), WAIT);
    expect(plugin[0]!.child.posted).toContain("dispose");
    expect(host.pluginHosts).toBe(0);

    expect(results(await ask(first))[0]?.state).toBe("verified");
    expect(plugin).toHaveLength(2);
  });

  it(`keeps at most ${MAX_PLUGIN_HOSTS} plugin hosts, evicting an idle one to start another`, async () => {
    const modules = new Map<string, unknown>();
    const providers: string[] = [];
    for (let index = 0; index <= MAX_PLUGIN_HOSTS; index += 1) {
      const { url, providerId } = installPlugin(`acme.p${index}`, "export {}");
      modules.set(url, markerModule());
      providers.push(providerId);
    }
    const { host, plugin, peak } = harness(modules);
    const id = await workspace(host);
    for (const providerId of providers) {
      const response = await host.resolve(
        request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)])]),
        { projectId: "p1" }
      );
      expect(results(response)[0]?.state).toBe("verified");
      expect(host.pluginHosts).toBeLessThanOrEqual(MAX_PLUGIN_HOSTS);
    }
    expect(plugin).toHaveLength(MAX_PLUGIN_HOSTS + 1);
    expect(peak()).toBeLessThanOrEqual(MAX_PLUGIN_HOSTS);
    // The longest idle went first.
    expect(plugin[0]!.child.alive).toBe(false);
    expect(plugin.slice(1).every((entry) => entry.child.alive)).toBe(true);
  });

  it("counts plugin resolves against the shared admission limit", async () => {
    const { url, providerId } = installPlugin("acme.slow", "export {}");
    let entered = 0;
    const { host } = harness(new Map([[url, stallingModule(() => (entered += 1))]]));
    const id = await workspace(host);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      host.resolve(
        request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)])]),
        { projectId: "p1", signal: controller.signal }
      )
    );
    await vi.waitFor(() => expect(entered).toBe(4), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(4);
    // A queued request withdrawn alone settles without ever reaching the resolver.
    controllers[5]!.abort();
    expect(results(await pending[5]!)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "cancelled" },
    ]);
    expect(entered).toBe(4);
    for (const controller of controllers) controller.abort();
    const settled = await Promise.all(pending);
    expect(settled.flatMap(results).map((result) => result.state)).toEqual(
      Array.from({ length: 6 }, () => "unavailable")
    );
  });

  it("keeps a failing provider's failure to its own candidates", async () => {
    const crashing = installPlugin("acme.crash", "export {}");
    const healthy = installPlugin("acme.ok", "export {}");
    const throwing = installPlugin("acme.throw", "export {}");
    const { host, core, plugin } = harness(
      new Map<string, unknown>([
        [crashing.url, stallingModule()],
        [healthy.url, markerModule()],
        [
          throwing.url,
          moduleOf(async () => {
            throw new Error("boom");
          }),
        ],
      ])
    );
    const id = await workspace(host);
    const pending = host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-core", "app/src/App.svelte"),
          candidate("c-crash", "app/src/App.svelte", crashing.providerId),
          candidate("c-ok", "app/src/App.svelte", healthy.providerId),
          candidate("c-throw", "app/src/App.svelte", throwing.providerId),
        ]),
      ]),
      { projectId: "p1" }
    );
    await vi.waitFor(
      () =>
        expect(plugin.find((entry) => entry.pluginId === "acme.crash")?.child.posted).toContain(
          "resolve"
        ),
      WAIT
    );
    plugin.find((entry) => entry.pluginId === "acme.crash")!.child.exit(1);
    const response = await pending;
    expect(results(response).map((result) => [result.candidateId, result.state])).toEqual([
      ["c-core", "verified"],
      ["c-crash", "unavailable"],
      ["c-ok", "verified"],
      ["c-throw", "unavailable"],
    ]);
    expect(results(response)[1]).toMatchObject({ reason: "unsupported" });
    expect(core[0]!.alive).toBe(true);
    expect(plugin.find((entry) => entry.pluginId === "acme.ok")!.child.alive).toBe(true);
  });

  it("drops an answer that claims a revision main never served, or a candidate it was not sent", async () => {
    const forging = installPlugin("acme.forge", "export {}");
    const straying = installPlugin("acme.stray", "export {}");
    const forged = moduleOf(async (request) => ({
      requestId: request.requestId,
      documentEpoch: request.documentEpoch,
      outcomes: request.observations.map((entry) => ({
        elementId: entry.elementId,
        results: observationCandidates(entry).map((source) => ({
          state: "verified" as const,
          candidateId: source.candidateId,
          claim: source.kind,
          target: {
            file: { workspaceId: request.workspaceId, path: "app/src/App.svelte" },
            location: null,
          },
          fileRevision: `sha256:${"0".repeat(64)}`,
        })),
      })),
    }));
    const stray = moduleOf(async (request) => ({
      requestId: request.requestId,
      documentEpoch: request.documentEpoch,
      outcomes: [
        {
          elementId: request.observations[0]!.elementId,
          results: [unavailableResult(candidate("c-core", "app/src/App.svelte"), "unsupported")],
        },
      ],
    }));
    const { host } = harness(
      new Map<string, unknown>([
        [forging.url, forged],
        [straying.url, stray],
      ])
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-core", "app/src/App.svelte"),
          candidate("c-forge", "app/src/App.svelte", forging.providerId),
          candidate("c-stray", "app/src/App.svelte", straying.providerId),
        ]),
      ]),
      { projectId: "p1" }
    );
    expect(results(response)).toEqual([
      expect.objectContaining({ candidateId: "c-core", state: "verified" }),
      { state: "unavailable", candidateId: "c-forge", claim: "file-hint", reason: "unsupported" },
      { state: "unavailable", candidateId: "c-stray", claim: "file-hint", reason: "unsupported" },
    ]);
  });

  it("settles a plugin's work and retires its host when the plugin is unloaded", async () => {
    const { url, providerId } = installPlugin("acme.gone", "export {}");
    let entered = false;
    const { host, plugin } = harness(new Map([[url, stallingModule(() => (entered = true))]]));
    const id = await workspace(host);
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)])]),
      { projectId: "p1" }
    );
    await vi.waitFor(() => expect(entered).toBe(true), WAIT);
    unregisterElementPickerProviders("acme.gone");
    expect(results(await pending)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "unsupported" },
    ]);
    await vi.waitFor(() => expect(plugin[0]!.child.alive).toBe(false), WAIT);
    expect(host.pluginHosts).toBe(0);
  });

  it("starts nothing for an entry that is missing or resolves outside its plugin", async () => {
    const missing = installPlugin("acme.missing", null);
    const outside = installPlugin("acme.outside", null);
    const elsewhere = path.join(tempDir("picker-elsewhere-"), "resolver.mjs");
    fs.writeFileSync(elsewhere, "export default () => ({})");
    fs.mkdirSync(path.join(outside.dir, "dist", "picker"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(outside.dir, "dist", "picker", "resolver.mjs"));
    const { host, plugin } = harness(new Map());
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-missing", "app/src/App.svelte", missing.providerId),
          candidate("c-outside", "app/src/App.svelte", outside.providerId),
        ]),
      ]),
      { projectId: "p1" }
    );
    expect(results(response).map((result) => [result.candidateId, result.state])).toEqual([
      ["c-missing", "unavailable"],
      ["c-outside", "unavailable"],
    ]);
    expect(plugin).toHaveLength(0);
  });

  it("retires every plugin host on dispose", async () => {
    const { url, providerId } = installPlugin("acme.end", "export {}");
    const { host, plugin } = harness(new Map([[url, markerModule()]]));
    const id = await workspace(host);
    await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)])]),
      { projectId: "p1" }
    );
    expect(plugin[0]!.child.alive).toBe(true);
    await host.dispose();
    expect(plugin[0]!.child.alive).toBe(false);
    expect(host.pluginHosts).toBe(0);
  });
  it("never loads a plugin unloaded while its host was still starting", async () => {
    const { url, providerId } = installPlugin("acme.early", "export {}");
    const { host, plugin } = harness(new Map([[url, markerModule()]]), {
      pluginChild: { start: false },
    });
    const id = await workspace(host);
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte", providerId)])]),
      { projectId: "p1" }
    );
    await vi.waitFor(() => expect(plugin).toHaveLength(1), WAIT);
    unregisterElementPickerProviders("acme.early");
    plugin[0]!.child.start();
    expect(results(await pending)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "unsupported" },
    ]);
    expect(plugin[0]!.child.posted).not.toContain("provider");
    expect(plugin[0]!.child.posted).not.toContain("resolve");
  });

  it("shares one host between a plugin's providers and keeps one's failure from the other", async () => {
    const dir = tempDir("picker-plugin-install-");
    for (const name of ["good", "bad"]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, "resolver.mjs"), "export {}");
    }
    registerElementPickerProviders(
      "acme.pair",
      "acme.pair",
      ["good", "bad"].map((name) => ({
        id: name,
        name,
        detection: [{ kind: "global" as const, name, match: "exact" as const }],
        guestEntry: "guest.js",
        resolverEntry: `${name}/resolver.mjs`,
      })),
      dir
    );
    plugins.push("acme.pair");
    const { host, plugin } = harness(
      new Map<string, unknown>([
        [pathToFileURL(path.join(dir, "good", "resolver.mjs")).href, markerModule()],
        [
          pathToFileURL(path.join(dir, "bad", "resolver.mjs")).href,
          moduleOf(async () => {
            throw new Error("boom");
          }),
        ],
      ])
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-good", "app/src/App.svelte", "acme.pair.good"),
          candidate("c-bad", "app/src/App.svelte", "acme.pair.bad"),
        ]),
      ]),
      { projectId: "p1" }
    );
    expect(results(response).map((result) => [result.candidateId, result.state])).toEqual([
      ["c-good", "verified"],
      ["c-bad", "unavailable"],
    ]);
    expect(plugin).toHaveLength(1);
    expect(plugin[0]!.child.posted.filter((type) => type === "provider")).toHaveLength(2);
  });

  it("checks each of a plugin's providers on its own, keeping a sibling's answer when one forges a revision", async () => {
    const dir = tempDir("picker-plugin-install-");
    for (const name of ["good", "forge"]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, "resolver.mjs"), "export {}");
    }
    registerElementPickerProviders(
      "acme.forger",
      "acme.forger",
      ["good", "forge"].map((name) => ({
        id: name,
        name,
        detection: [{ kind: "global" as const, name, match: "exact" as const }],
        guestEntry: "guest.js",
        resolverEntry: `${name}/resolver.mjs`,
      })),
      dir
    );
    plugins.push("acme.forger");
    const forged = moduleOf(async (request) => ({
      requestId: request.requestId,
      documentEpoch: request.documentEpoch,
      outcomes: request.observations.map((entry) => ({
        elementId: entry.elementId,
        results: observationCandidates(entry).map((source) => ({
          state: "verified" as const,
          candidateId: source.candidateId,
          claim: source.kind,
          target: {
            file: { workspaceId: request.workspaceId, path: "app/src/App.svelte" },
            location: null,
          },
          fileRevision: `sha256:${"0".repeat(64)}`,
        })),
      })),
    }));
    const { host } = harness(
      new Map<string, unknown>([
        [pathToFileURL(path.join(dir, "good", "resolver.mjs")).href, markerModule()],
        [pathToFileURL(path.join(dir, "forge", "resolver.mjs")).href, forged],
      ])
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-good", "app/src/App.svelte", "acme.forger.good"),
          candidate("c-forge", "app/src/App.svelte", "acme.forger.forge"),
        ]),
      ]),
      { projectId: "p1" }
    );
    expect(results(response)).toEqual([
      expect.objectContaining({ candidateId: "c-good", state: "verified" }),
      { state: "unavailable", candidateId: "c-forge", claim: "file-hint", reason: "unsupported" },
    ]);
  });

  it("retires a plugin host that ignores a cancel, leaving core's answer standing", async () => {
    const { url, providerId } = installPlugin("acme.hung", "export {}");
    const hung = moduleOf(() => new Promise<ResolveResponse>(() => {}));
    const { host, core, plugin } = harness(new Map([[url, hung]]), { cancelGraceMs: 20 });
    const id = await workspace(host);
    const response = await host.resolve(
      request(
        id,
        [
          observation("el-1", [
            candidate("c-core", "app/src/App.svelte"),
            candidate("c-hung", "app/src/App.svelte", providerId),
          ]),
        ],
        // Long enough that real file I/O is done well before it; the cancel grace is what's under test.
        { deadlineMs: 1_500 }
      ),
      { projectId: "p1" }
    );
    expect(results(response).map((result) => [result.candidateId, result.state])).toEqual([
      ["c-core", "verified"],
      ["c-hung", "unavailable"],
    ]);
    expect(results(response)[1]).toMatchObject({ reason: "budget-exhausted" });
    await vi.waitFor(() => expect(plugin[0]!.child.alive).toBe(false), WAIT);
    expect(core[0]!.alive).toBe(true);
  });

  it("keeps a plugin's failure a failure when the deadline later stops core", async () => {
    const { url, providerId } = installPlugin("acme.fails", "export {}");
    const { host } = harness(
      new Map([
        [
          url,
          moduleOf(async () => {
            throw new Error("boom");
          }),
        ],
      ]),
      { coreLoaders: { svelte: async () => stallingResolver(true) } }
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(
        id,
        [
          observation("el-1", [
            candidate("c-core", "app/src/App.svelte"),
            candidate("c-fails", "app/src/App.svelte", providerId),
          ]),
        ],
        { deadlineMs: 1_000 }
      ),
      { projectId: "p1" }
    );
    expect(results(response)).toEqual([
      {
        state: "unavailable",
        candidateId: "c-core",
        claim: "file-hint",
        reason: "budget-exhausted",
      },
      { state: "unavailable", candidateId: "c-fails", claim: "file-hint", reason: "unsupported" },
    ]);
  });

  it("holds core and plugin reads to one budget for the selection", async () => {
    const { url, providerId } = installPlugin("acme.reader", "export {}");
    const { host } = harness(new Map([[url, markerModule()]]));
    const id = await workspace(host);
    const response = await host.resolve(
      request(
        id,
        [
          observation("el-1", [
            candidate("c-core", "app/src/App.svelte"),
            candidate("c-plugin", "app/src/App.svelte", providerId),
          ]),
        ],
        { maxFiles: 1 }
      ),
      { projectId: "p1" }
    );
    const states = results(response).map((result) =>
      result.state === "unavailable" ? result.reason : result.state
    );
    expect(states.sort()).toEqual(["budget-exhausted", "verified"]);
  });
});
