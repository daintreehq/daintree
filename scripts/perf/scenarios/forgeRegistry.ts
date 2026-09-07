import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import { serializedBytes } from "../lib/ipcFixture";
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
  declaredHostnames,
  declaredProviderIds,
  drainRelayMicrotasks,
  ensureRecordingRenderer,
  loadForgeModules,
  pluginServiceRecorder,
  resetForgeRegistry,
  scaleProviders,
  workspaceClientRecorder,
  type ForgeRpcRequestLike,
  type ImplRecorder,
} from "../lib/forgeRegistryFixture";

/**
 * The main-process forge layer — registration, resolution, the workspace-host
 * RPC surface, and the registry's change relays.
 *
 * `lib/forgeRegistryFixture.ts` states exactly what is real and what is stubbed;
 * the short version is that every routing decision measured here is made by
 * unmodified product code, and the only things replaced are Electron itself,
 * `PluginService` and `WorkspaceClient`, all three at the module boundary.
 *
 * The traps this family is built against, and where each is caught:
 *   - **A registry that registers nothing resolves instantly.** PERF-340 reads
 *     the descriptor and matcher tables back against every provider that was
 *     registered — corpus and scale tier alike, since both go in through the
 *     same call and both are in the table the scenario prices — and PERF-341's
 *     positive rows all miss when the tables are empty.
 *   - **Dropping rows nobody grades is the cheapest win of all.** Every oracle
 *     here is built from the declarations that went IN, never read back out of
 *     the table being graded, and covers the whole roster rather than the
 *     subset the expectation rows happen to name.
 *   - **A resolver that returns the first provider for every query is fast and
 *     wrong.** PERF-341 grades an expectation table in both directions: seven
 *     rows must route to NOTHING, three of them where a configured override or
 *     default names something unavailable and the product deliberately refuses
 *     to fall through.
 *   - **A dispatcher that answers everything the same way is fastest of all.**
 *     PERF-342 declares the outcome every request is owed, including two error
 *     shapes and the `not-ready`/`no-match` split.
 */

const PROJECT_PATH = "/tmp/daintree-perf-forge/project";

// --- PERF-341 ---------------------------------------------------------------

interface ResolutionOutcome {
  providerId: string | null;
  via: string | null;
  matcherId: string | null;
}

function gradeResolutions(
  outcomes: readonly ResolutionOutcome[],
  registeredIds: readonly string[],
  declaredIds: readonly string[]
): { resolutionMisses: number; matcherRoutingMisses: number } {
  let resolutionMisses = 0;
  let matcherRoutingMisses = 0;

  RESOLUTION_CASES.forEach((expectation, index) => {
    const outcome = outcomes[index];
    if (!outcome) {
      resolutionMisses += 1;
      matcherRoutingMisses += 1;
      return;
    }
    if (outcome.providerId !== expectation.expectedProviderId) resolutionMisses += 1;
    if (outcome.via !== expectation.expectedVia) resolutionMisses += 1;
    if (outcome.matcherId !== expectation.expectedMatcherId) matcherRoutingMisses += 1;
  });

  // Guards the table itself: a corpus edit that stopped registering a provider
  // named by an expectation would otherwise turn positive rows into a shared
  // null on both sides and read as a clean pass.
  const registered = new Set(registeredIds);
  for (const expectation of RESOLUTION_CASES) {
    if (expectation.expectedProviderId && !registered.has(expectation.expectedProviderId)) {
      resolutionMisses += 1;
    }
  }

  // And guards the POOL the sweep was answered against, by symmetric difference
  // against what was declared for this tier. The expectations name six corpus
  // providers, so a scale tier that never registered leaves every row correct
  // while the scaled sweep silently becomes a small-pool sweep — the reading
  // this scenario exists to take.
  const declared = new Set(declaredIds);
  for (const id of declared) if (!registered.has(id)) resolutionMisses += 1;
  for (const id of registered) if (!declared.has(id)) resolutionMisses += 1;

  return { resolutionMisses, matcherRoutingMisses };
}

// --- PERF-342 ---------------------------------------------------------------

interface RpcStep {
  request: ForgeRpcRequestLike;
  /** Provider methods this request must enter. Zero for a coalesced duplicate. */
  expectedProviderCalls: number;
  /**
   * Implicit `activate()` calls this request must force.
   *
   * Declared separately from {@link expectedProviderCalls} because the two
   * diverge exactly where the behaviour matters: a request naming a provider
   * whose impl never bound must still activate its plugin, which is the whole
   * point of the implicit-activation path — a dispatcher that skipped it is
   * faster and leaves every lazily-binding plugin unreachable on first use.
   */
  expectedActivations: number;
  expectOk: boolean;
  /** Reads the delivered envelope value; false is a miss. */
  check: (value: unknown) => boolean;
}

interface RpcGroup {
  /** Requests dispatched together, so the singleflight has something to fold. */
  steps: RpcStep[];
}

const REPO_REF = { host: "github.com", owner: "daintreehq", repo: "daintree", rawData: null };
const TRACKED_PRS = Array.from({ length: 24 }, (_, index) => ({
  number: index + 1,
  updatedAt: 1_700_000_000_000 + index,
  headRefName: `feature/${index}`,
  state: "open",
}));

const COALESCED_BRANCH = "feature/coalesced";
const COALESCE_FANOUT = 8;

function isResolved(value: unknown, namespacedId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as {
    status?: string;
    namespacedId?: string;
    repo?: { projectPath?: string };
  };
  return (
    result.status === "resolved" &&
    result.namespacedId === namespacedId &&
    result.repo?.projectPath === PROJECT_PATH
  );
}

function hasStatus(value: unknown, status: string): boolean {
  return (
    typeof value === "object" && value !== null && (value as { status?: string }).status === status
  );
}

/**
 * The RPC script, as ordered groups.
 *
 * Group 0 runs while the plugin scan is still incomplete, because `not-ready`
 * and `no-match` are the same miss to a caller that cannot tell them apart —
 * and the workspace-host's retry policy turns on exactly that difference
 * (#9997). Group 2 is the singleflight probe: eight identical requests
 * dispatched in one tick must reach the provider once and come back eight
 * times, while three requests differing only by branch must not fold at all.
 */
function buildRpcGroups(): RpcGroup[] {
  let id = 0;
  const nextId = (): string => `perf-rpc-${(id += 1)}`;

  const notReady: RpcGroup = {
    steps: [
      {
        request: {
          forgeRequestId: nextId(),
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath: PROJECT_PATH,
            },
          ],
        },
        expectedProviderCalls: 0,
        expectedActivations: 0,
        expectOk: true,
        check: (value) => hasStatus(value, "not-ready"),
      },
    ],
  };

  const resolution: RpcGroup = {
    steps: [
      {
        request: {
          forgeRequestId: nextId(),
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://github.com/daintreehq/daintree.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath: PROJECT_PATH,
            },
          ],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => isResolved(value, GITHUB_PROVIDER_ID),
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://gitea.acme.example/acme/widgets.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath: PROJECT_PATH,
            },
          ],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => isResolved(value, GITEA_PROVIDER_ID),
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath: PROJECT_PATH,
            },
          ],
        },
        expectedProviderCalls: 0,
        expectedActivations: 0,
        expectOk: true,
        check: (value) => hasStatus(value, "no-match"),
      },
      {
        // Descriptor registered, impl never bound: the routing table looks
        // populated and the call still must not resolve.
        request: {
          forgeRequestId: nextId(),
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://bitbucket.contoso.example/team/repo.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath: PROJECT_PATH,
            },
          ],
        },
        expectedProviderCalls: 0,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => hasStatus(value, "no-match"),
      },
    ],
  };

  const coalescing: RpcGroup = { steps: [] };
  for (let i = 0; i < COALESCE_FANOUT; i += 1) {
    coalescing.steps.push({
      request: {
        forgeRequestId: nextId(),
        method: "findPRByBranch",
        namespacedId: GITHUB_PROVIDER_ID,
        args: [REPO_REF, COALESCED_BRANCH],
      },
      // Only the leader reaches the provider; the other seven join it.
      expectedProviderCalls: i === 0 ? 1 : 0,
      expectedActivations: i === 0 ? 1 : 0,
      expectOk: true,
      check: (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { number?: number }).number === COALESCED_BRANCH.length,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    coalescing.steps.push({
      request: {
        forgeRequestId: nextId(),
        method: "findPRByBranch",
        namespacedId: GITHUB_PROVIDER_ID,
        args: [REPO_REF, `feature/distinct-${i}`],
      },
      expectedProviderCalls: 1,
      expectedActivations: 1,
      expectOk: true,
      check: (value) => typeof value === "object" && value !== null,
    });
  }

  const payloads: RpcGroup = {
    steps: [
      {
        request: {
          forgeRequestId: nextId(),
          method: "findPRsByBranches",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [REPO_REF, TRACKED_PRS.map((pr) => pr.headRefName)],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => value instanceof Map && value.size === TRACKED_PRS.length,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "findPRsByNumbers",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [REPO_REF, TRACKED_PRS.map((pr) => pr.number)],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => value instanceof Map && value.size === TRACKED_PRS.length,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "getCIStatuses",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [REPO_REF, TRACKED_PRS.map((pr) => pr.number)],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => value instanceof Map && value.size === TRACKED_PRS.length,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "probeOpenPRList",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [REPO_REF, TRACKED_PRS],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) =>
          typeof value === "object" &&
          value !== null &&
          Array.isArray((value as { openNumbers?: unknown[] }).openNumbers),
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "getIssue",
          namespacedId: GITEA_PROVIDER_ID,
          args: [{ ...REPO_REF, host: "gitea.acme.example" }, 4242],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => (value as { number?: number } | null)?.number === 4242,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "getRateLimit",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => (value as { limit?: number } | null)?.limit === 5000,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "clearPullRequestCaches",
          namespacedId: GITHUB_PROVIDER_ID,
          args: [],
        },
        expectedProviderCalls: 1,
        expectedActivations: 1,
        expectOk: true,
        check: (value) => value === null,
      },
      {
        // Bound to a provider whose impl never registered.
        request: {
          forgeRequestId: nextId(),
          method: "getPR",
          namespacedId: BITBUCKET_PROVIDER_ID,
          args: [REPO_REF, 1],
        },
        expectedProviderCalls: 0,
        expectedActivations: 1,
        expectOk: false,
        check: () => true,
      },
      {
        request: {
          forgeRequestId: nextId(),
          method: "getPR",
          namespacedId: "nobody.nothing",
          args: [REPO_REF, 1],
        },
        expectedProviderCalls: 0,
        expectedActivations: 1,
        expectOk: false,
        check: () => true,
      },
    ],
  };

  return [notReady, resolution, coalescing, payloads];
}

interface DeliveredEnvelope {
  forgeRequestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

// --- PERF-343 ---------------------------------------------------------------

const REBOUND_TOKEN_STATE = {
  status: "unhealthy" as const,
  tokenVersion: 9,
  checkedAt: 1_700_000_500_000,
};

const RATE_LIMIT_EVENT = {
  limit: 5000,
  remaining: 120,
  resetAt: 1_700_000_900_000,
  throttleMultiplier: 3,
};

export const forgeRegistryScenarios: PerfScenario[] = [
  {
    id: "PERF-340",
    name: "Forge Registry - Contribution Registration and Matcher Table",
    description:
      "Register a forge-provider corpus through the real registerForgeProviders (which deep-freezes " +
      "every contribution), then read the descriptor table, the hostname matcher table and the impl " +
      "table back out of the product's own accessors. Scaled to 126 providers so the O(plugins x " +
      "contributions) shape of the table builders is visible, and graded over all 126 rather than " +
      "the six-provider corpus: the expectation is rebuilt from the same generator the scale tier " +
      "was registered from, so a matcher builder that omits every scale row scores its 120 missing " +
      "rows instead of reporting a faster matcherBuildMs. descriptorMisses reads the descriptor and " +
      "matcher tables against the declared roster by symmetric difference, implBindMisses asserts " +
      "the descriptor/impl split the shipped cold-start bug turns on (descriptors eager from the " +
      "manifest, impls only from activate()), unregisterMisses checks a plugin's removal takes its " +
      "own rows and nobody else's, and registryChangeMisses is a signed count of the change " +
      "signal that drives both relays.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["descriptorMisses", "implBindMisses", "unregisterMisses", "registryChangeMisses"],
    async run() {
      const mods = await resetForgeRegistry();
      const scale = scaleProviders();
      const recorder = createImplRecorder();
      const impl = createProviderImpl(recorder, { host: "github.com" });
      const idOf = (entry: { pluginId: string; contribution: { id: string } }): string =>
        mods.makeForgeProviderId(entry.pluginId, entry.contribution.id);

      let registryChangeEvents = 0;
      const unsubscribe = mods.onForgeProviderRegistryChanged(() => {
        registryChangeEvents += 1;
      });

      try {
        const start = performance.now();

        const corpusStart = performance.now();
        for (const plugin of FORGE_CORPUS) {
          mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
        }
        const corpusRegisterMs = performance.now() - corpusStart;

        // Read before any impl binds: this is the state a lazy plugin leaves
        // behind, and the count that made PERF-225 necessary.
        const descriptorsBeforeBind = mods.getRegisteredForgeProviders();
        const hadImplBeforeBind = mods.hasActivatedForgeProvider();

        const scaleStart = performance.now();
        for (const plugin of scale) {
          mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
        }
        const scaleRegisterMs = performance.now() - scaleStart;
        const descriptorsAfterScale = mods.getRegisteredForgeProviders();

        const matcherStart = performance.now();
        const matchers = mods.listForgeProviderMatchers();
        const matcherBuildMs = performance.now() - matcherStart;

        mods.registerForgeProviderImpl("daintree.github", "github", impl);
        const boundImpl = mods.getForgeProviderImpl(GITHUB_PROVIDER_ID);
        const hadImplAfterBind = mods.hasActivatedForgeProvider();
        const descriptorsAfterBind = mods.getRegisteredForgeProviders().length;

        const unregisterStart = performance.now();
        mods.unregisterForgeProviders("acme.gitea");
        mods.unregisterForgeProviderImpls("daintree.github");
        const unregisterMs = performance.now() - unregisterStart;

        const survivors = new Set(mods.getRegisteredForgeProviders().map(idOf));
        const implsAfterUnregister = mods.getForgeProviderImplEntries().length;

        const durationMs = performance.now() - start;

        const declaredIds = new Set(CORPUS_PROVIDER_IDS);
        const observedIds = new Set(descriptorsBeforeBind.map(idOf));
        let descriptorMisses = 0;
        for (const id of declaredIds) if (!observedIds.has(id)) descriptorMisses += 1;
        for (const id of observedIds) if (!declaredIds.has(id)) descriptorMisses += 1;

        // The scale tier registers through the same entry point, so it is
        // graded the same way: its 120 rows are what `scaleRegisterMs` and
        // everything measured after it are priced against.
        const scaledRoster = [...FORGE_CORPUS, ...scale];
        const declaredScaledIds = new Set(declaredProviderIds(scaledRoster));
        const observedScaledIds = new Set(descriptorsAfterScale.map(idOf));
        for (const id of declaredScaledIds) {
          if (!observedScaledIds.has(id)) descriptorMisses += 1;
        }
        for (const id of observedScaledIds) {
          if (!declaredScaledIds.has(id)) descriptorMisses += 1;
        }

        // The matcher table is the routing view of the WHOLE registered roster,
        // so it is graded against every declaration that went into it. Grading
        // only the six corpus rows let a builder that omits the 120 scale rows
        // report a faster `matcherBuildMs` with all three predicates at zero —
        // the table is built at 126 providers precisely to price that size.
        const declaredMatcherHostnames = declaredHostnames(scaledRoster);
        const seenMatcherIds = new Set<string>();
        for (const entry of matchers) {
          const declared = declaredMatcherHostnames.get(entry.providerId);
          if (!declared) {
            descriptorMisses += 1 + entry.hostnames.length;
            continue;
          }
          if (seenMatcherIds.has(entry.providerId)) {
            descriptorMisses += 1;
            continue;
          }
          seenMatcherIds.add(entry.providerId);
          const observed = new Set(entry.hostnames);
          for (const hostname of declared) if (!observed.has(hostname)) descriptorMisses += 1;
          for (const hostname of observed) {
            if (!declared.includes(hostname)) descriptorMisses += 1;
          }
        }
        for (const [providerId, hostnames] of declaredMatcherHostnames) {
          if (!seenMatcherIds.has(providerId)) descriptorMisses += 1 + hostnames.length;
        }

        let implBindMisses = 0;
        // Descriptors present, nothing activated: the registry must say so.
        if (hadImplBeforeBind) implBindMisses += 1;
        if (!hadImplAfterBind) implBindMisses += 1;
        if (boundImpl !== impl) implBindMisses += 1;
        // Binding an impl must not manufacture a descriptor.
        if (descriptorsAfterBind !== descriptorsBeforeBind.length + scale.length) {
          implBindMisses += 1;
        }

        let unregisterMisses = 0;
        if (survivors.has(GITEA_PROVIDER_ID)) unregisterMisses += 1;
        // A removal that clears the whole table is as wrong as one that clears
        // nothing, and equally invisible in a duration. Graded over the scale
        // tier as well as the corpus, since both registered through the same
        // entry point and only the full roster shows a removal that overreached.
        for (const id of declaredScaledIds) {
          if (id !== GITEA_PROVIDER_ID && !survivors.has(id)) unregisterMisses += 1;
        }
        for (const id of survivors) {
          if (!declaredScaledIds.has(id)) unregisterMisses += 1;
        }
        if (implsAfterUnregister !== 0) unregisterMisses += 1;

        // The change signal is the only thing driving the health and matcher
        // relays, and its fan-out sits inside the registration brackets above:
        // one notification per mutation — 126 registrations, one impl bind and
        // the two removals. Signed, so a registry that batched or stopped
        // notifying and a registry that notified twice per call are different
        // readings rather than the same non-zero.
        const expectedRegistryChangeEvents = FORGE_CORPUS.length + scale.length + 3;
        const registryChangeMisses = expectedRegistryChangeEvents - registryChangeEvents;

        return {
          durationMs,
          metrics: {
            registeredProviderCount: descriptorsBeforeBind.length,
            scaledProviderCount: descriptorsAfterScale.length,
            matcherEntryCount: matchers.length,
            matcherHostnameCount: matchers.reduce(
              (total, entry) => total + entry.hostnames.length,
              0
            ),
            registryChangeEvents,
            descriptorBytes: serializedBytes(descriptorsBeforeBind),
            corpusRegisterMs,
            scaleRegisterMs,
            matcherBuildMs,
            unregisterMs,
            descriptorMisses,
            implBindMisses,
            unregisterMisses,
            registryChangeMisses,
          },
        };
      } finally {
        unsubscribe();
      }
    },
  },
  {
    id: "PERF-341",
    name: "Forge Resolution - Expectation Table, Both Directions",
    description:
      "Drive the real resolveForgeProvider across a 20-row table declaring which query must route " +
      "to which provider AND which must route to none, then re-answer the hostname rows through the " +
      "workspace-host's own matchProviderForRemoteUrl over the relayed matcher table. Seven rows " +
      "must resolve to nothing, three of them because a configured override or global default names " +
      "something unavailable and the product deliberately refuses to fall through — so a resolver " +
      "that returns the first registered provider for every query, which is the fastest wrong " +
      "answer available, fails every one of them while getting faster. Swept again at 126 providers, " +
      "with the pool itself read back and graded by symmetric difference against the generator that " +
      "produced it — the expectations name only corpus providers, so a scale tier that never " +
      "registered would otherwise turn the scaled sweep into a small-pool sweep reported as a " +
      "scaled one.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["resolutionMisses", "matcherRoutingMisses"],
    async run() {
      const mods = await resetForgeRegistry({ withCorpus: true });
      const SWEEPS = 6;

      const perResolve: number[] = [];
      let outcomes: ResolutionOutcome[] = [];

      const start = performance.now();
      for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
        const sweepOutcomes: ResolutionOutcome[] = [];
        const matchers = mods.listForgeProviderMatchers();
        for (const testCase of RESOLUTION_CASES) {
          const t0 = performance.now();
          const resolved = mods.resolveForgeProvider({
            remoteUrl: testCase.remoteUrl,
            forgeProviderOverride: testCase.forgeProviderOverride,
            globalDefaultProviderId: testCase.globalDefaultProviderId,
          });
          perResolve.push(performance.now() - t0);
          const matcherId =
            typeof testCase.remoteUrl === "string" && testCase.remoteUrl.length > 0
              ? mods.matchProviderForRemoteUrl(testCase.remoteUrl, matchers)
              : null;
          sweepOutcomes.push({
            providerId: resolved.entry
              ? mods.makeForgeProviderId(resolved.entry.pluginId, resolved.entry.contribution.id)
              : null,
            via: resolved.resolvedVia,
            matcherId,
          });
        }
        outcomes = sweepOutcomes;
      }
      const smallPoolMs = performance.now() - start;
      const idOf = (entry: { pluginId: string; contribution: { id: string } }): string =>
        mods.makeForgeProviderId(entry.pluginId, entry.contribution.id);
      const smallPoolIds = mods.getRegisteredForgeProviders().map(idOf);

      // Scale tier: the corpus expectations must be unchanged by 120 providers
      // that claim no corpus hostname, so a lookup that got faster by dropping
      // candidates shows up as a miss rather than as a win.
      const scale = scaleProviders();
      for (const plugin of scale) {
        mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
      }
      const scaledStart = performance.now();
      const scaledOutcomes: ResolutionOutcome[] = [];
      const scaledMatchers = mods.listForgeProviderMatchers();
      for (const testCase of RESOLUTION_CASES) {
        const resolved = mods.resolveForgeProvider({
          remoteUrl: testCase.remoteUrl,
          forgeProviderOverride: testCase.forgeProviderOverride,
          globalDefaultProviderId: testCase.globalDefaultProviderId,
        });
        scaledOutcomes.push({
          providerId: resolved.entry
            ? mods.makeForgeProviderId(resolved.entry.pluginId, resolved.entry.contribution.id)
            : null,
          via: resolved.resolvedVia,
          matcherId:
            typeof testCase.remoteUrl === "string" && testCase.remoteUrl.length > 0
              ? mods.matchProviderForRemoteUrl(testCase.remoteUrl, scaledMatchers)
              : null,
        });
      }
      const scaledPoolMs = performance.now() - scaledStart;
      const durationMs = smallPoolMs + scaledPoolMs;

      const scaledPoolIds = mods.getRegisteredForgeProviders().map(idOf);
      const small = gradeResolutions(outcomes, smallPoolIds, CORPUS_PROVIDER_IDS);
      const scaled = gradeResolutions(
        scaledOutcomes,
        scaledPoolIds,
        declaredProviderIds([...FORGE_CORPUS, ...scale])
      );

      return {
        durationMs,
        metrics: {
          resolutionCount: perResolve.length + RESOLUTION_CASES.length,
          expectationRowCount: RESOLUTION_CASES.length,
          mustRouteNowhereRowCount: RESOLUTION_CASES.filter((c) => c.expectedProviderId === null)
            .length,
          smallPoolProviderCount: smallPoolIds.length,
          scaledPoolProviderCount: scaledPoolIds.length,
          avgResolveMs: perResolve.reduce((sum, ms) => sum + ms, 0) / perResolve.length,
          p95ResolveMs: percentile(perResolve, 95),
          scaledSweepMs: scaledPoolMs,
          resolutionMisses: small.resolutionMisses + scaled.resolutionMisses,
          matcherRoutingMisses: small.matcherRoutingMisses + scaled.matcherRoutingMisses,
        },
      };
    },
  },
  {
    id: "PERF-342",
    name: "Forge RPC - Dispatch, Singleflight and Payload Bytes",
    description:
      "Drive the real dispatchForgeRpc, the single point where a workspace host crosses into the " +
      "forge layer, across the whole ForgeRpcMethod union. Priced in MESSAGES and BYTES rather than " +
      "wall clock, because the transport here is a recording sender rather than Electron's " +
      "MessagePortMain: the envelope counts and the serialized payload sizes are the product's and " +
      "travel across machines, the transit time is not. Eight identical requests dispatched in one " +
      "tick must reach the provider once and come back eight times; three that differ only by " +
      "branch must not fold at all. coalescingMisses is a signed subtraction, so over-coalescing " +
      "(which drops a caller's answer) reads as negative and under-coalescing as positive, and " +
      "implicitActivationMisses is the same shape over the implicit activate() every request owes " +
      "its owning plugin — including the two that name a provider with no impl bound.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 16 },
    warmups: 2,
    correctness: [
      "rpcOutcomeMisses",
      "coalescingMisses",
      "deliveryMisses",
      "implicitActivationMisses",
    ],
    async run() {
      const mods = await resetForgeRegistry({ withCorpus: true });
      const recorder = createImplRecorder();
      mods.registerForgeProviderImpl(
        "daintree.github",
        "github",
        createProviderImpl(recorder, { host: "github.com" })
      );
      mods.registerForgeProviderImpl(
        "acme.gitea",
        "gitea",
        createProviderImpl(recorder, { host: "gitea.acme.example" })
      );

      const groups = buildRpcGroups();
      const delivered = new Map<string, DeliveredEnvelope[]>();
      let resultMessageCount = 0;
      let resultBytes = 0;
      let requestBytes = 0;

      const sender = (request: unknown): boolean => {
        const envelope = request as DeliveredEnvelope;
        resultMessageCount += 1;
        resultBytes += serializedBytes(request);
        const existing = delivered.get(envelope.forgeRequestId);
        if (existing) existing.push(envelope);
        else delivered.set(envelope.forgeRequestId, [envelope]);
        return true;
      };

      // The workspace-host keeps its cold-start retry until the scan completes,
      // so group 0 has to run against an incomplete scan.
      pluginServiceRecorder.scanComplete = false;

      const start = performance.now();
      for (const [index, group] of groups.entries()) {
        if (index === 1) pluginServiceRecorder.scanComplete = true;
        await Promise.all(
          group.steps.map((step) => {
            requestBytes += serializedBytes(step.request);
            return mods.dispatchForgeRpc(step.request, sender);
          })
        );
      }
      const durationMs = performance.now() - start;

      const steps = groups.flatMap((group) => group.steps);
      let rpcOutcomeMisses = 0;
      let deliveryMisses = 0;
      for (const step of steps) {
        const envelopes = delivered.get(step.request.forgeRequestId) ?? [];
        if (envelopes.length !== 1) {
          deliveryMisses += 1;
          if (envelopes.length === 0) {
            rpcOutcomeMisses += 1;
            continue;
          }
        }
        const envelope = envelopes[0] as DeliveredEnvelope;
        if (envelope.ok !== step.expectOk) {
          rpcOutcomeMisses += 1;
          continue;
        }
        if (envelope.ok && !step.check(envelope.value)) rpcOutcomeMisses += 1;
        if (!envelope.ok && typeof envelope.error !== "string") rpcOutcomeMisses += 1;
      }

      const expectedProviderCalls = steps.reduce(
        (total, step) => total + step.expectedProviderCalls,
        0
      );
      const coalescingMisses = expectedProviderCalls - recorder.calls.length;

      const expectedActivations = steps.reduce(
        (total, step) => total + step.expectedActivations,
        0
      );
      const implicitActivationMisses =
        expectedActivations - pluginServiceRecorder.activations.length;

      return {
        durationMs,
        metrics: {
          rpcRequestCount: steps.length,
          resultMessageCount,
          resultBytes,
          requestBytes,
          bytesPerResult: resultBytes / Math.max(1, resultMessageCount),
          providerInvocationCount: recorder.calls.length,
          coalescedRequestCount: COALESCE_FANOUT - 1,
          implicitActivationCount: pluginServiceRecorder.activations.length,
          rpcOutcomeMisses,
          coalescingMisses,
          deliveryMisses,
          implicitActivationMisses,
        },
      };
    },
  },
  {
    id: "PERF-343",
    name: "Forge Relays - Health Subscriptions and Matcher Push",
    description:
      "The registry's change signal drives two relays, and both are graded here across a churn a " +
      "plugin reload actually produces: bind three impls (one with rate-limit events, one without, " +
      "one with no health surface at all), emit health, re-bind one impl under the same id, then " +
      "unregister another. The relay must dispose the replaced impl's subscriptions — measured by " +
      "emitting through the provider's own post-dispose listener list, which is empty only if the " +
      "disposer really ran — and must broadcast the healthy-reset pair for a provider that went " +
      "away, so a renderer does not pin a stale unhealthy state. Broadcasts travel the real " +
      "broadcastToRenderer and the real webContentsRegistry into a recording stand-in view.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 10, nightly: 14 },
    warmups: 2,
    correctness: [
      "healthDeliveryMisses",
      "staleBroadcastMisses",
      "resetBroadcastMisses",
      "matcherRelayMisses",
    ],
    async run() {
      const renderer = await ensureRecordingRenderer();
      const mods = await loadForgeModules();
      mods.disposeForgeHealthRelay();
      await resetForgeRegistry({ withCorpus: true });
      mods.initForgeHealthRelay();
      mods.initForgeMatcherRelay();
      await drainRelayMicrotasks();

      // Setup is done; everything after this point is the graded workload.
      renderer.sends = [];
      renderer.bytes = 0;
      workspaceClientRecorder.matcherPushes = [];
      workspaceClientRecorder.throttleRelays = [];

      const githubRecorder = createImplRecorder();
      const giteaRecorder = createImplRecorder();
      const bitbucketRecorder = createImplRecorder();
      const rebindRecorder = createImplRecorder();

      const start = performance.now();

      mods.registerForgeProviderImpl(
        "daintree.github",
        "github",
        createProviderImpl(githubRecorder, { host: "github.com" })
      );
      mods.registerForgeProviderImpl(
        "acme.gitea",
        "gitea",
        createProviderImpl(giteaRecorder, {
          host: "gitea.acme.example",
          withRateLimitEvents: false,
        })
      );
      mods.registerForgeProviderImpl(
        "contoso.bitbucket",
        "bitbucket",
        createProviderImpl(bitbucketRecorder, {
          host: "bitbucket.contoso.example",
          withHealthEvents: false,
        })
      );

      const emit = (recorder: ImplRecorder): number => {
        let emitted = 0;
        for (const listener of [...recorder.tokenHealthListeners]) {
          listener(REBOUND_TOKEN_STATE);
          emitted += 1;
        }
        for (const listener of [...recorder.rateLimitListeners]) {
          listener(RATE_LIMIT_EVENT);
          emitted += 1;
        }
        return emitted;
      };

      const liveEmissions = emit(githubRecorder) + emit(giteaRecorder) + emit(bitbucketRecorder);
      await drainRelayMicrotasks();
      const afterLive = renderer.sends.length;

      // Re-bind the same key with a fresh impl object: identity diffing must
      // drop the old subscriptions and pick up the new ones.
      mods.registerForgeProviderImpl(
        "daintree.github",
        "github",
        createProviderImpl(rebindRecorder, { host: "github.com" })
      );
      const staleEmissionsAttempted = emit(githubRecorder);
      await drainRelayMicrotasks();
      const afterRebind = renderer.sends.length;

      mods.unregisterForgeProviderImpls("acme.gitea");
      mods.unregisterForgeProviders("acme.gitea");
      await drainRelayMicrotasks();
      const staleAfterRemoval = emit(giteaRecorder);
      await drainRelayMicrotasks();

      const durationMs = performance.now() - start;

      const tokenHealthSends = renderer.sends.filter((s) => s.channel === mods.tokenHealthChannel);
      const rateLimitSends = renderer.sends.filter((s) => s.channel === mods.rateLimitChannel);

      // Every live emission must have produced exactly one broadcast, and the
      // provider that declares no health surface must have produced none.
      let healthDeliveryMisses = Math.abs(afterLive - liveEmissions);
      if (
        !tokenHealthSends.some(
          (send) => (send.payload as { providerId?: string }).providerId === GITHUB_PROVIDER_ID
        )
      ) {
        healthDeliveryMisses += 1;
      }
      if (
        !tokenHealthSends.some(
          (send) => (send.payload as { providerId?: string }).providerId === GITEA_PROVIDER_ID
        )
      ) {
        healthDeliveryMisses += 1;
      }
      if (
        renderer.sends.some(
          (send) => (send.payload as { providerId?: string }).providerId === BITBUCKET_PROVIDER_ID
        )
      ) {
        healthDeliveryMisses += 1;
      }
      // The throttle multiplier must be relayed live off the callback argument.
      if (!workspaceClientRecorder.throttleRelays.includes(RATE_LIMIT_EVENT.throttleMultiplier)) {
        healthDeliveryMisses += 1;
      }

      // A leaked subscription shows up as a listener the relay never removed,
      // which is exactly what makes the post-dispose emission observable.
      const staleBroadcastMisses =
        staleEmissionsAttempted + staleAfterRemoval + (afterRebind - afterLive);

      const resetSends = tokenHealthSends.filter(
        (send) =>
          (send.payload as { providerId?: string }).providerId === GITEA_PROVIDER_ID &&
          (send.payload as { isUnhealthy?: boolean }).isUnhealthy === false
      );
      const resetRateSends = rateLimitSends.filter(
        (send) =>
          (send.payload as { providerId?: string }).providerId === GITEA_PROVIDER_ID &&
          (send.payload as { state?: { limit: number | null } }).state?.limit === null
      );
      const resetBroadcastMisses =
        Math.abs(1 - resetSends.length) + Math.abs(1 - resetRateSends.length);

      const lastPush = workspaceClientRecorder.matcherPushes.at(-1);
      let matcherRelayMisses = 0;
      if (!lastPush) {
        matcherRelayMisses = CORPUS_HOSTNAMES.size;
      } else {
        const pushed = new Map(lastPush.map((entry) => [entry.providerId, entry.hostnames]));
        for (const [providerId, hostnames] of CORPUS_HOSTNAMES) {
          // `acme.gitea` was unregistered above, so its row must be gone.
          const expected = providerId === GITEA_PROVIDER_ID ? null : hostnames;
          const observed = pushed.get(providerId);
          if (expected === null) {
            if (observed) matcherRelayMisses += 1;
            continue;
          }
          if (!observed || observed.length !== expected.length) {
            matcherRelayMisses += 1;
            continue;
          }
          for (const hostname of expected) {
            if (!observed.includes(hostname)) matcherRelayMisses += 1;
          }
        }
        // The other direction: a relay pushing rows nobody declared is as wrong
        // as one pushing a stale table, and just as invisible in a duration.
        for (const providerId of pushed.keys()) {
          if (!CORPUS_HOSTNAMES.has(providerId)) matcherRelayMisses += 1;
        }
      }

      mods.disposeForgeHealthRelay();

      return {
        durationMs,
        metrics: {
          broadcastCount: renderer.sends.length,
          tokenHealthBroadcastCount: tokenHealthSends.length,
          rateLimitBroadcastCount: rateLimitSends.length,
          broadcastBytes: renderer.bytes,
          healthSubscribeCount:
            githubRecorder.subscribeCount +
            giteaRecorder.subscribeCount +
            rebindRecorder.subscribeCount,
          healthDisposeCount:
            githubRecorder.disposeCount + giteaRecorder.disposeCount + rebindRecorder.disposeCount,
          matcherPushCount: workspaceClientRecorder.matcherPushes.length,
          throttleRelayCount: workspaceClientRecorder.throttleRelays.length,
          healthDeliveryMisses,
          staleBroadcastMisses,
          resetBroadcastMisses,
          matcherRelayMisses,
        },
      };
    },
  },
];
