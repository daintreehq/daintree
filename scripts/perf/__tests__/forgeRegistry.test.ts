import { describe, expect, it, vi } from "vitest";

import {
  BITBUCKET_PROVIDER_ID,
  CORPUS_HOSTNAMES,
  CORPUS_PROVIDER_IDS,
  FORGE_CORPUS,
  GITEA_PROVIDER_ID,
  GITHUB_PROVIDER_ID,
  RESOLUTION_CASES,
  createImplRecorder,
  createProviderImpl,
  scaleProviders,
} from "../lib/forgeRegistryFixture";
import { forgeRegistryScenarios } from "../scenarios/forgeRegistry";
import { EXPECTED_SCENARIO_IDS } from "../scenarios";

/**
 * Two jobs here, and neither is re-running the benchmark.
 *
 * The first is the ORACLE. Every predicate in this family grades what the
 * product did against a declaration in this fixture, so a declaration that
 * quietly stopped describing the corpus would turn four miss counts into
 * decoration reporting zero forever. The expectation table is checked for
 * internal consistency, and — the row that matters — for actually containing
 * negative cases, since a table of positives alone cannot tell a real resolver
 * from one that answers everything.
 *
 * The second is LINKAGE. The scenarios load main-process modules through a
 * Node loader hook that Vitest never runs, so the mocks below stand in for it
 * and the import graph is exercised in ordinary CI rather than only under
 * `npm run perf`, which gates nothing and is not on pull requests.
 */

vi.mock("electron", () => {
  const noop = (): undefined => undefined;
  return {
    app: {
      getPath: () => "/tmp/daintree-perf-forge",
      getVersion: () => "0.0.0-perf",
      getName: () => "Daintree",
      isPackaged: false,
      on: noop,
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {
      static getAllWindows(): unknown[] {
        return [];
      }
    },
    WebContentsView: class {},
    webContents: { getAllWebContents: () => [] },
    ipcMain: { on: noop, handle: noop, removeHandler: noop },
    shell: { openExternal: noop },
    dialog: {},
    session: {},
    net: {},
    nativeTheme: { on: noop },
    utilityProcess: { fork: noop },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock("../../../electron/services/PluginService.js", () => ({
  pluginService: {
    activatePluginForForgeProvider: async (): Promise<void> => undefined,
    isPluginScanComplete: true,
  },
}));

vi.mock("../../../electron/services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => ({
    relayForgeProviderMatchers: (): void => undefined,
    relayFetchThrottle: (): void => undefined,
  }),
}));

describe("forge perf corpus and expectation table", () => {
  it("declares provider ids that match the corpus it registers", () => {
    const derived = FORGE_CORPUS.flatMap((plugin) =>
      plugin.contributions.map((contribution) => `${plugin.pluginId}.${contribution.id}`)
    );
    expect([...CORPUS_PROVIDER_IDS]).toEqual(derived);
    expect(CORPUS_HOSTNAMES.size).toBe(derived.length);
    for (const id of [GITHUB_PROVIDER_ID, GITEA_PROVIDER_ID, BITBUCKET_PROVIDER_ID]) {
      expect(derived).toContain(id);
    }
  });

  it("claims one hostname twice, so first-registered-wins is asserted and not assumed", () => {
    const claimants = FORGE_CORPUS.filter((plugin) =>
      plugin.contributions.some((contribution) =>
        contribution.matches.includes("gitea.acme.example")
      )
    ).map((plugin) => plugin.pluginId);
    expect(claimants).toEqual(["acme.gitea", "contoso.mirror"]);
  });

  it("names only registered providers in its positive expectations", () => {
    const registered = new Set(CORPUS_PROVIDER_IDS);
    for (const testCase of RESOLUTION_CASES) {
      if (testCase.expectedProviderId) {
        expect(registered.has(testCase.expectedProviderId)).toBe(true);
      }
      if (testCase.expectedMatcherId) {
        expect(registered.has(testCase.expectedMatcherId)).toBe(true);
      }
      // A row that expects a provider must say which tier chose it, and a row
      // that expects none must not claim a tier — otherwise half the grading
      // is vacuous.
      expect(testCase.expectedProviderId === null).toBe(testCase.expectedVia === null);
    }
  });

  it("grades in both directions: the table carries rows that must route nowhere", () => {
    const negatives = RESOLUTION_CASES.filter((testCase) => testCase.expectedProviderId === null);
    expect(negatives.length).toBeGreaterThanOrEqual(5);
    // The two no-fallthrough rules are the behaviour most easily lost, so each
    // has to be present by name rather than by count.
    expect(negatives.some((testCase) => testCase.forgeProviderOverride === "nobody.nothing")).toBe(
      true
    );
    expect(
      negatives.some(
        (testCase) =>
          testCase.globalDefaultProviderId === BITBUCKET_PROVIDER_ID && testCase.remoteUrl !== null
      )
    ).toBe(true);
    // And rows where the two graded paths must DISAGREE, which is what proves
    // the matcher reading is independent of the resolver reading.
    expect(
      RESOLUTION_CASES.some(
        (testCase) => testCase.expectedProviderId !== testCase.expectedMatcherId
      )
    ).toBe(true);
  });

  it("scales without colliding with any corpus hostname", () => {
    const corpusHosts = new Set([...CORPUS_HOSTNAMES.values()].flat());
    for (const plugin of scaleProviders(8)) {
      for (const contribution of plugin.contributions) {
        for (const hostname of contribution.matches) {
          expect(corpusHosts.has(hostname)).toBe(false);
        }
      }
    }
  });
});

describe("forge perf scenarios", () => {
  it("declares ids that are in the matrix and predicates on every one", () => {
    for (const scenario of forgeRegistryScenarios) {
      expect(EXPECTED_SCENARIO_IDS.has(scenario.id)).toBe(true);
      expect(scenario.correctness?.length ?? 0).toBeGreaterThan(0);
    }
    expect(forgeRegistryScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-340",
      "PERF-341",
      "PERF-342",
      "PERF-343",
    ]);
  });
});

describe("forge perf module linkage", () => {
  it("loads the real registry, resolver and RPC server and routes one call through them", async () => {
    const { loadForgeModules } = await import("../lib/forgeRegistryFixture");
    const mods = await loadForgeModules();

    mods.clearForgeProviderImplRegistry();
    mods.clearForgeProviderRegistry();
    mods.resetForgeRpcInFlight();
    for (const plugin of FORGE_CORPUS) {
      mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
    }

    expect(mods.getRegisteredForgeProviders()).toHaveLength(CORPUS_PROVIDER_IDS.length);
    expect(mods.hasActivatedForgeProvider()).toBe(false);

    const recorder = createImplRecorder();
    mods.registerForgeProviderImpl(
      "daintree.github",
      "github",
      createProviderImpl(recorder, { host: "github.com" })
    );
    expect(mods.hasActivatedForgeProvider()).toBe(true);

    const resolved = mods.resolveForgeProvider({
      remoteUrl: "git@gitea.acme.example:acme/widgets.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });
    expect(resolved.resolvedVia).toBe("hostname");
    expect(resolved.entry?.pluginId).toBe("acme.gitea");

    const envelopes: Array<{ ok: boolean; value?: unknown }> = [];
    await mods.dispatchForgeRpc(
      {
        forgeRequestId: "linkage-1",
        method: "resolveProvider",
        args: [
          {
            remoteUrl: "https://github.com/daintreehq/daintree.git",
            forgeProviderOverride: null,
            globalDefaultProviderId: null,
            projectPath: "/tmp/linkage",
          },
        ],
      },
      (request) => {
        envelopes.push(request as { ok: boolean; value?: unknown });
        return true;
      }
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.ok).toBe(true);
    expect(envelopes[0]?.value).toMatchObject({
      status: "resolved",
      namespacedId: GITHUB_PROVIDER_ID,
    });

    mods.clearForgeProviderImplRegistry();
    mods.clearForgeProviderRegistry();
  });
});
