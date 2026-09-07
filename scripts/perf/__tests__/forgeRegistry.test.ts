import { describe, expect, it, vi } from "vitest";

import {
  BITBUCKET_PROVIDER_ID,
  CORPUS_HOSTNAMES,
  CORPUS_PROVIDER_IDS,
  FORGE_CORPUS,
  GITEA_PROVIDER_ID,
  GITHUB_PROVIDER_ID,
  RESOLUTION_CASES,
  SCALE_PROVIDER_COUNT,
  createImplRecorder,
  createProviderImpl,
  declaredHostnames,
  declaredProviderIds,
  pluginServiceRecorder,
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

// Both mocks delegate to the fixture's own recorders — the same objects the
// loader-hook stubs write to under `npm run perf` — so a scenario driven from
// here grades the same evidence it grades in a real run.
vi.mock("../../../electron/services/PluginService.js", async () => {
  const { pluginServiceRecorder: recorder } = await import("../lib/forgeRegistryFixture");
  return {
    pluginService: {
      activatePluginForForgeProvider: async (namespacedId: string): Promise<void> => {
        recorder.activations.push(namespacedId);
      },
      get isPluginScanComplete(): boolean {
        return recorder.scanComplete;
      },
    },
  };
});

vi.mock("../../../electron/services/WorkspaceClient.js", async () => {
  const { workspaceClientRecorder: recorder } = await import("../lib/forgeRegistryFixture");
  return {
    getWorkspaceClient: () => ({
      relayForgeProviderMatchers: (matchers: unknown[]): void => {
        recorder.matcherPushes.push(matchers as never);
      },
      relayFetchThrottle: (multiplier: number): void => {
        recorder.throttleRelays.push(multiplier);
      },
    }),
  };
});

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

  it("derives the scale tier's expectation from the generator, at full roster width", () => {
    const sample = declaredHostnames(scaleProviders(4));
    expect(sample.size).toBe(4);
    expect(sample.get("perf.forge0.provider")).toEqual([
      "forge0.perf.invalid",
      "alt-forge0.perf.invalid",
    ]);

    // The matcher table is built from the whole roster, so the oracle has to
    // be too: a corpus-only expectation covers six of its 126 rows and grades
    // a builder that dropped the other 120 as perfect.
    const roster = [...FORGE_CORPUS, ...scaleProviders()];
    expect(declaredProviderIds(roster)).toHaveLength(
      CORPUS_PROVIDER_IDS.length + SCALE_PROVIDER_COUNT
    );
    expect(declaredHostnames(roster).size).toBe(CORPUS_HOSTNAMES.size + SCALE_PROVIDER_COUNT);
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

describe("forge perf scenarios grade the whole workload", () => {
  const context = { mode: "smoke" as const, now: () => performance.now() };

  const runScenario = async (
    id: string
  ): Promise<{ metrics: Record<string, number>; predicates: readonly string[] }> => {
    const scenario = forgeRegistryScenarios.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`${id} is not in this family`);
    const sample = await scenario.run(context);
    return { metrics: sample.metrics ?? {}, predicates: scenario.correctness ?? [] };
  };

  const expectAllPredicatesZero = (
    metrics: Record<string, number>,
    predicates: readonly string[]
  ): void => {
    for (const key of predicates) {
      expect(`${key}=${String(metrics[key])}`).toBe(`${key}=0`);
    }
  };

  it("PERF-340 grades the matcher table over every provider that went into it", async () => {
    const { metrics, predicates } = await runScenario("PERF-340");
    // The size the scenario claims to be pricing, read out of the run itself:
    // 126 rows carrying 7 corpus hostnames and two per scale provider.
    expect(metrics.scaledProviderCount).toBe(126);
    expect(metrics.matcherEntryCount).toBe(126);
    expect(metrics.matcherHostnameCount).toBe(247);
    expectAllPredicatesZero(metrics, predicates);
  });

  it("PERF-341 grades the pool the scaled sweep was answered against", async () => {
    const { metrics, predicates } = await runScenario("PERF-341");
    expect(metrics.smallPoolProviderCount).toBe(CORPUS_PROVIDER_IDS.length);
    expect(metrics.scaledPoolProviderCount).toBe(CORPUS_PROVIDER_IDS.length + SCALE_PROVIDER_COUNT);
    expectAllPredicatesZero(metrics, predicates);
  });

  it("PERF-342 grades the implicit activation every request owes its plugin", async () => {
    const { metrics, predicates } = await runScenario("PERF-342");
    // Counted here rather than derived from the step table, so the two
    // statements of the same expectation have to agree.
    expect(metrics.implicitActivationCount).toBe(16);
    expect(pluginServiceRecorder.activations).toHaveLength(16);
    expectAllPredicatesZero(metrics, predicates);
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
