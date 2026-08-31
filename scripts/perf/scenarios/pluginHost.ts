import { performance } from "node:perf_hooks";
import type { PerfScenario, ScenarioSample } from "../types";
import {
  CONSENT_PLUGIN_ID,
  ECHO_ACTION,
  EXPECTED_CONSENT_LADDER,
  EXPECTED_STATIC_GATE,
  FORGE_PROVIDER_ID,
  HOST_CALL_ACTION,
  expectedRegistrationKeys,
  livePluginChildCount,
  nonce,
  pluginCorpus,
  spawnPluginServiceHost,
  spawnPluginWorker,
  workerFixtureBundle,
  type GateProbeOutcome,
  type PluginServiceHost,
  type PluginWorker,
} from "../lib/pluginHostFixture";

/**
 * The plugin system.
 *
 * PERF-220..225 drive the REAL plugin subsystem: `electron/plugin-dev-worker.ts`
 * forked into its own OS process for the user-plugin path, and the real
 * `PluginService` — scan, manifest schema, contribution registries, host
 * factory, capability and consent gates — in a second child for the built-in
 * path. `lib/pluginHostFixture.ts` states what that boundary is and, just as
 * importantly, what it is not.
 *
 * Every scenario here leads with a count or a byte total rather than a latency,
 * because a plugin host that fails to contribute anything is the fastest
 * possible plugin host and would otherwise record the best numbers the harness
 * has ever seen. The counts are read back out of the product's own registries
 * and out of the messages that actually crossed the process boundary, never out
 * of the subsystem's own report of what it did.
 *
 * `PluginMcpSupervisor`, `PluginInstaller` and `PluginArchive` are deliberately
 * absent: they spawn external MCP servers and download and verify signed
 * archives, so neither is hermetic and a number from either would be a number
 * about the network.
 */

const PLUGIN_ID = "perfco.worker";

const WORKER_BOOT_TIMEOUT_MS = 30_000;
const WORKER_ACTIVATE_TIMEOUT_MS = 30_000;
const INVOKE_TIMEOUT_MS = 20_000;
const DISPOSE_TIMEOUT_MS = 5_000;
/** Cold module load of the whole PluginService graph plus a 29-manifest scan. */
const SERVICE_INIT_TIMEOUT_MS = 120_000;
const SERVICE_COMMAND_TIMEOUT_MS = 60_000;

/** Invoke-direction round trips: main -> worker action handler -> main. */
const INVOKE_ROUND_TRIPS = 60;
/** Host-call-direction round trips the plugin issues from inside one action. */
const HOST_CALL_ROUND_TRIPS = 40;
/** Kill/refork cycles for the respawn scenario. */
const RESPAWN_CYCLES = 3;
/** Repeats of the static gate battery, so the decision cost is not one sample. */
const GATE_ROUNDS = 40;

/**
 * A measurement that did not happen. Reported as a sample with the misses set
 * rather than thrown, so one bad boot annotates the run instead of aborting it
 * — and so the number never silently reads as a good one.
 */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

/**
 * Tear a child down, then count the plugin children still running.
 *
 * Taken AFTER teardown on purpose: read while the child is up it is a
 * tautology, and `residualChildCount` is the one reading that says whether a
 * scenario left a process behind for every later scenario to pay for.
 */
async function teardown(child: PluginWorker | PluginServiceHost): Promise<number> {
  child.kill();
  if (!(await child.waitForExit(DISPOSE_TIMEOUT_MS))) {
    child.kill();
    await child.waitForExit(DISPOSE_TIMEOUT_MS);
  }
  return livePluginChildCount();
}

/**
 * Grade one battery of gate outcomes against what the parent expected.
 *
 * Three separate readings, because they fail differently. A gate that allowed
 * something it must deny has failed OPEN, which is a security defect. One that
 * denied something it must allow has failed CLOSED, which breaks plugins. One
 * that reached the right verdict for the wrong reason has drifted — a host
 * closure called with the wrong arity denies with a TypeError, and without the
 * kind check that reads as a clean pass.
 */
function gradeGate(
  outcomes: readonly GateProbeOutcome[],
  expected: ReadonlyArray<{ label: string; allowed: boolean; denialKind: string }>
): { failOpen: number; failClosed: number; kindMismatch: number } {
  let failOpen = 0;
  let failClosed = 0;
  let kindMismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const got = outcomes[i];
    if (!got || got.label !== want.label) {
      // A missing or reordered probe is not evidence of anything; count it the
      // safe way rather than skipping it.
      failClosed += 1;
      continue;
    }
    if (got.allowed !== want.allowed) {
      if (got.allowed) failOpen += 1;
      else failClosed += 1;
      continue;
    }
    if (got.denialKind !== want.denialKind) kindMismatch += 1;
  }
  return { failOpen, failClosed, kindMismatch };
}

export const pluginHostScenarios: PerfScenario[] = [
  {
    id: "PERF-220",
    name: "Plugin Worker Boot, Activation and Clean Dispose",
    description:
      "Fork the real plugin worker (electron/plugin-dev-worker.ts, the same entry packaged prod plugins run in) into its own process, time the ready handshake, activate a generated fixture plugin, then ask it to shut down and confirm the process actually exits zero. The main-side supervisor (PluginDevWorkerHost) and bridge (PluginDevWorkerMainBridge) are NOT in the loop — the parent here is a counting stand-in.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["bootReadyMisses", "activateMisses", "cleanupMisses", "disposeExitMisses"],
    async run() {
      const worker = spawnPluginWorker();
      try {
        const bootMs = await worker.waitForReady(WORKER_BOOT_TIMEOUT_MS);
        if (bootMs === null) {
          return failClosed(`plugin worker never became ready: ${worker.stderr.slice(-400)}`, {
            bootReadyMisses: 1,
            activateMisses: 1,
            cleanupMisses: 1,
            disposeExitMisses: 1,
            bootMessages: worker.responseMessages,
            bootBytes: worker.responseBytes,
            registrationCount: 0,
            residualChildCount: await teardown(worker),
          });
        }

        // Everything the worker volunteers before it is usable. A boot that
        // looks faster because it deferred work shows here rather than nowhere.
        const bootMessages = worker.responseMessages;
        const bootBytes = worker.responseBytes;

        const activated = await worker.activate(
          workerFixtureBundle(),
          PLUGIN_ID,
          WORKER_ACTIVATE_TIMEOUT_MS
        );
        const disposeMs = await worker.disposeGracefully(DISPOSE_TIMEOUT_MS);
        const residualChildCount = await teardown(worker);

        return {
          durationMs: bootMs,
          metrics: {
            bootMessages,
            bootBytes,
            activateMs: activated?.activateMs ?? WORKER_ACTIVATE_TIMEOUT_MS,
            // Registrations that crossed the boundary during activate(). Read
            // beside `activateMisses`: an activation that registered nothing
            // is the fastest one available.
            registrationCount: worker.registrations.length,
            disposeMs: disposeMs ?? DISPOSE_TIMEOUT_MS,
            bootReadyMisses: 0,
            activateMisses: activated ? 0 : 1,
            // `activate()` returns a disposer and the worker must retain it —
            // a worker that dropped it exits just as promptly and leaks the
            // plugin's cleanup on every reload.
            cleanupMisses: activated?.hasCleanup ? 0 : 1,
            // Zero only when the worker exited on its own AND exited zero.
            disposeExitMisses: disposeMs === null ? 1 : 0,
            residualChildCount,
          },
          notes: activated ? undefined : `activate() never completed: ${worker.stderr.slice(-300)}`,
        };
      } finally {
        worker.kill();
      }
    },
  },
  {
    id: "PERF-221",
    name: "Plugin Discovery, Manifest Validation and Contribution Registration",
    description:
      "Run the real PluginService.initialize() over a generated 29-manifest corpus (24 valid, 4 schema violations, 1 reserved daintree.* namespace from the user root) and read every contribution back out of the product's own panel-kind, toolbar, keybinding, context-menu, agent and forge-provider registries. Electron is an inert stub, so there is no renderer and no broadcast; every headline here is a count, a byte total or a structural cardinality.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["initMisses", "loadMisses", "rejectMisses", "contributionMisses"],
    async run() {
      const corpus = pluginCorpus();
      const child = spawnPluginServiceHost();
      try {
        const result = await child.init(corpus, SERVICE_INIT_TIMEOUT_MS);
        if (!result) {
          return failClosed(`PluginService never initialized: ${child.stderr.slice(-400)}`, {
            initMisses: 1,
            loadMisses: corpus.validCount,
            rejectMisses: 0,
            contributionMisses:
              corpus.expected.panelKinds +
              corpus.expected.toolbarButtons +
              corpus.expected.keybindings +
              corpus.expected.contextMenus +
              corpus.expected.agents +
              corpus.expected.forgeDescriptors,
            manifestScanCount: corpus.manifestDirCount,
            pluginLoadCount: 0,
            residualChildCount: await teardown(child),
          });
        }

        // The corpus owns the `perfco.` namespace, so anything loaded outside it
        // is a manifest the validator was supposed to have rejected.
        const loadedValid = result.loadedIds.filter((id) => id.startsWith("perfco.")).length;
        const loadedInvalid = result.loadedIds.filter((id) => !id.startsWith("perfco.")).length;

        const expected = corpus.expected;
        const contributionMisses =
          Math.abs(expected.panelKinds - result.panelKindCount) +
          Math.abs(expected.toolbarButtons - result.toolbarButtonCount) +
          Math.abs(expected.keybindings - result.keybindingCount) +
          Math.abs(expected.contextMenus - result.contextMenuCount) +
          Math.abs(expected.agents - result.agentCount) +
          Math.abs(expected.forgeDescriptors - result.forgeDescriptorCount);

        const residualChildCount = await teardown(child);

        return {
          durationMs: result.initializeMs,
          metrics: {
            // Cold load of the whole plugin module graph, paid once per launch
            // before a single manifest is read.
            moduleLoadMs: result.moduleLoadMs,
            manifestScanCount: corpus.manifestDirCount,
            manifestBytes: result.manifestBytes,
            pluginLoadCount: result.pluginLoadCount,
            panelKindCount: result.panelKindCount,
            toolbarButtonCount: result.toolbarButtonCount,
            keybindingCount: result.keybindingCount,
            contextMenuCount: result.contextMenuCount,
            agentCount: result.agentCount,
            forgeDescriptorCount: result.forgeDescriptorCount,
            // The pairings. A scan that loaded nothing is instant, a validator
            // that accepts everything is faster than one that checks, and a
            // load that registered no contributions is faster than both.
            initMisses: 0,
            loadMisses: Math.max(0, corpus.validCount - loadedValid),
            rejectMisses: loadedInvalid,
            contributionMisses,
            residualChildCount,
          },
          notes:
            contributionMisses > 0
              ? `${contributionMisses} contribution(s) declared in the corpus never reached a registry`
              : loadedInvalid > 0
                ? `${loadedInvalid} manifest(s) that must be rejected were loaded`
                : undefined,
        };
      } finally {
        child.kill();
      }
    },
  },
  {
    id: "PERF-222",
    name: "Plugin Capability and Consent Gate",
    description:
      "Evaluate 364 real gate decisions against a real plugin host: the static manifest.capabilities check, path containment through resolveContainedPath, and the just-in-time consent ladder through PluginCapabilityConsentService and its grant store. Both directions are graded, because a gate that fails open is fast and wrong and one that denies everything is faster and just as wrong. The consent DIALOG cannot exist here — this fixture supplies the renderer's bridge and drives it to each outcome.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["gateFailOpenMisses", "gateFailClosedMisses", "gateKindMisses", "sentinelMisses"],
    async run() {
      const corpus = pluginCorpus();
      const child = spawnPluginServiceHost();
      const sentinel = nonce("perf-222");
      const expectedDecisions =
        GATE_ROUNDS * EXPECTED_STATIC_GATE.length + EXPECTED_CONSENT_LADDER.length;
      try {
        const init = await child.init(corpus, SERVICE_INIT_TIMEOUT_MS);
        const gate = init
          ? await child.runGateBattery(GATE_ROUNDS, sentinel, SERVICE_COMMAND_TIMEOUT_MS)
          : null;
        if (!gate) {
          return failClosed(`gate battery never ran: ${child.stderr.slice(-400)}`, {
            gateFailOpenMisses: 0,
            // Nothing was evaluated, so every expected verdict is missing.
            gateFailClosedMisses: EXPECTED_STATIC_GATE.length + EXPECTED_CONSENT_LADDER.length,
            gateKindMisses: 0,
            sentinelMisses: 3,
            gateDecisionCount: 0,
            residualChildCount: await teardown(child),
          });
        }

        const staticGrade = gradeGate(gate.staticOutcomes, EXPECTED_STATIC_GATE);
        const consentGrade = gradeGate(gate.consentOutcomes, EXPECTED_CONSENT_LADDER);

        // Allowing a call is not the same as serving it: an "allow" that hands
        // back nothing is indistinguishable from a denial the plugin swallowed.
        // Each allow row carries the bytes that actually crossed.
        let sentinelMisses = 0;
        if (gate.staticOutcomes[0]?.value !== sentinel) sentinelMisses += 1;
        if (gate.consentOutcomes[2]?.value !== sentinel) sentinelMisses += 1;
        if (gate.consentOutcomes[3]?.value !== `${sentinel}-again`) sentinelMisses += 1;

        const denials = [...gate.staticOutcomes, ...gate.consentOutcomes];
        const residualChildCount = await teardown(child);

        return {
          durationMs: gate.batteryMs,
          metrics: {
            gateDecisionCount: gate.decisionCount,
            capabilityDenialCount: denials.filter((o) => o.denialKind === "capability").length,
            containmentDenialCount: denials.filter((o) => o.denialKind === "containment").length,
            consentDenialCount: denials.filter((o) => o.denialKind === "consent").length,
            grantedAllowCount: denials.filter((o) => o.allowed).length,
            // Fixed by construction; reported so a battery that silently
            // shrank is visible next to a duration that got better.
            decisionShortfallCount: Math.max(0, expectedDecisions - gate.decisionCount),
            gateFailOpenMisses: staticGrade.failOpen + consentGrade.failOpen,
            gateFailClosedMisses: staticGrade.failClosed + consentGrade.failClosed,
            gateKindMisses: staticGrade.kindMismatch + consentGrade.kindMismatch,
            sentinelMisses,
            residualChildCount,
          },
          notes:
            staticGrade.failOpen + consentGrade.failOpen > 0
              ? `${staticGrade.failOpen + consentGrade.failOpen} gate decision(s) failed OPEN`
              : undefined,
        };
      } finally {
        child.kill();
      }
    },
  },
  {
    id: "PERF-223",
    name: "Plugin Boundary Round Trip (messages and bytes)",
    description:
      "60 main-to-worker action invokes and 40 worker-to-main host calls across the real plugin process boundary, each carrying a 64-character nonce that must come back intact. Reports messages and structured-clone bytes each way. The worker half — PluginDevWorkerHostProxy's correlation, activation-window revoke and handler registry — is real; the main half is a counting stand-in, so this prices the channel and the proxy, not a real host call.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["invokeMisses", "nonceMisses", "hostCallMisses", "registrationMisses"],
    async run() {
      const worker = spawnPluginWorker();
      try {
        const bootMs = await worker.waitForReady(WORKER_BOOT_TIMEOUT_MS);
        const activated =
          bootMs === null
            ? null
            : await worker.activate(workerFixtureBundle(), PLUGIN_ID, WORKER_ACTIVATE_TIMEOUT_MS);
        if (!activated) {
          return failClosed(`plugin worker never activated: ${worker.stderr.slice(-400)}`, {
            invokeMisses: INVOKE_ROUND_TRIPS,
            nonceMisses: INVOKE_ROUND_TRIPS,
            hostCallMisses: HOST_CALL_ROUND_TRIPS,
            registrationMisses: expectedRegistrationKeys(PLUGIN_ID).size,
            invokeRoundTrips: 0,
            hostCallRoundTrips: 0,
            requestMessages: 0,
            responseMessages: 0,
            requestBytes: 0,
            responseBytes: 0,
            residualChildCount: await teardown(worker),
          });
        }

        // Activation traffic is excluded: this measures the cost of asking, not
        // the cost of starting. PERF-220 owns the boot and activation numbers.
        const channelMark = worker.mark();

        const wanted = expectedRegistrationKeys(PLUGIN_ID);
        const arrived = new Set(
          worker.registrations
            .filter((r) => r.registrationKey !== null)
            .map((r) => r.registrationKey as string)
        );
        const registrationMisses = [...wanted].filter((key) => !arrived.has(key)).length;

        const started = performance.now();
        let invokeMisses = 0;
        let nonceMisses = 0;
        for (let i = 0; i < INVOKE_ROUND_TRIPS; i += 1) {
          const token = nonce(`perf-223-${i}`);
          const result = await worker.invokeAction(
            `perf-223-invoke-${i}`,
            `${PLUGIN_ID}.${ECHO_ACTION}`,
            { token },
            INVOKE_TIMEOUT_MS
          );
          if (result === null) {
            invokeMisses += 1;
            nonceMisses += 1;
            continue;
          }
          if ((result as { token?: string }).token !== token) nonceMisses += 1;
        }

        const hostCallNonce = nonce("perf-223-hostcall");
        const hostCallResult = await worker.invokeAction(
          "perf-223-hostcalls",
          `${PLUGIN_ID}.${HOST_CALL_ACTION}`,
          { nonce: hostCallNonce, rounds: HOST_CALL_ROUND_TRIPS },
          INVOKE_TIMEOUT_MS
        );
        const durationMs = performance.now() - started;

        // Each entry is what the stand-in bridge echoed for one host call. A
        // channel that answered nothing is arbitrarily fast, and one that
        // answered the wrong thing is faster still.
        let hostCallMisses = HOST_CALL_ROUND_TRIPS;
        if (Array.isArray(hostCallResult)) {
          let matched = 0;
          for (let i = 0; i < HOST_CALL_ROUND_TRIPS; i += 1) {
            const entry = hostCallResult[i] as { echo?: unknown } | undefined;
            if (entry?.echo === `${hostCallNonce}-${i}`) matched += 1;
          }
          hostCallMisses = HOST_CALL_ROUND_TRIPS - matched;
        }

        const channel = worker.since(channelMark);
        const roundTrips = INVOKE_ROUND_TRIPS + HOST_CALL_ROUND_TRIPS;
        const residualChildCount = await teardown(worker);

        return {
          durationMs,
          metrics: {
            invokeRoundTrips: INVOKE_ROUND_TRIPS,
            hostCallRoundTrips: worker.hostCalls,
            requestMessages: channel.requestMessages,
            responseMessages: channel.responseMessages,
            requestBytes: channel.requestBytes,
            responseBytes: channel.responseBytes,
            // Deterministic shape number: how much channel traffic one plugin
            // round trip costs, in bytes, regardless of the machine.
            bytesPerRoundTrip:
              roundTrips > 0 ? (channel.requestBytes + channel.responseBytes) / roundTrips : 0,
            invokeMisses,
            nonceMisses,
            hostCallMisses,
            registrationMisses,
            residualChildCount,
          },
          notes:
            nonceMisses > 0
              ? `${nonceMisses} of ${INVOKE_ROUND_TRIPS} invoke nonces did not survive the boundary`
              : undefined,
        };
      } finally {
        worker.kill();
      }
    },
  },
  {
    id: "PERF-224",
    name: "Plugin Worker Respawn Readiness After Repeated Kills",
    description:
      "SIGKILL the plugin worker three times over, re-forking and re-activating each time, measuring respawn-to-activated and confirming the replacement actually serves an invoke. The product supervisor is NOT in this loop — PluginDevWorkerHost owns the fork, the reload debounce, the respawn and the error surfacing, so this answers how fast a killed plugin worker comes back and whether it works, not whether Daintree would have restarted it.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 2, ci: 3, nightly: 5 },
    warmups: 0,
    correctness: [
      "respawnReadyMisses",
      "respawnActivateMisses",
      "respawnInvokeMisses",
      "reapMisses",
    ],
    async run() {
      let worker = spawnPluginWorker();
      let respawnReadyMisses = 0;
      let respawnActivateMisses = 0;
      let respawnInvokeMisses = 0;
      let reapMisses = 0;
      let respawns = 0;
      let respawnToActivatedMaxMs = 0;

      const started = performance.now();
      try {
        const firstBoot = await worker.waitForReady(WORKER_BOOT_TIMEOUT_MS);
        if (firstBoot === null) {
          return failClosed(`plugin worker never became ready: ${worker.stderr.slice(-400)}`, {
            crashRespawnCount: 0,
            respawnReadyMisses: RESPAWN_CYCLES,
            respawnActivateMisses: RESPAWN_CYCLES,
            respawnInvokeMisses: RESPAWN_CYCLES,
            reapMisses: 0,
            respawnToActivatedMaxMs: 0,
            residualChildCount: await teardown(worker),
          });
        }

        for (let cycle = 0; cycle < RESPAWN_CYCLES; cycle += 1) {
          worker.kill();
          // The replacement must not be forked until the corpse is reaped, or
          // "recovery" is measured against two live workers. An unreaped worker
          // stops the loop rather than stacking another one on top of it.
          if (!(await worker.waitForExit(DISPOSE_TIMEOUT_MS))) {
            reapMisses += 1;
            break;
          }

          worker = spawnPluginWorker();
          respawns += 1;
          const cycleStart = performance.now();
          const ready = await worker.waitForReady(WORKER_BOOT_TIMEOUT_MS);
          if (ready === null) {
            respawnReadyMisses += 1;
            respawnActivateMisses += 1;
            respawnInvokeMisses += 1;
            continue;
          }
          const activated = await worker.activate(
            workerFixtureBundle(),
            PLUGIN_ID,
            WORKER_ACTIVATE_TIMEOUT_MS
          );
          if (!activated) {
            respawnActivateMisses += 1;
            respawnInvokeMisses += 1;
            continue;
          }
          respawnToActivatedMaxMs = Math.max(
            respawnToActivatedMaxMs,
            performance.now() - cycleStart
          );
          // A worker that boots and activates but answers nothing is the
          // crash-loop failure mode worth catching; a ready message alone, or
          // even an `activated` one, would miss it.
          const token = nonce(`perf-224-${cycle}`);
          const echoed = await worker.invokeAction(
            `perf-224-${cycle}`,
            `${PLUGIN_ID}.${ECHO_ACTION}`,
            { token },
            INVOKE_TIMEOUT_MS
          );
          if ((echoed as { token?: string } | null)?.token !== token) respawnInvokeMisses += 1;
        }

        const durationMs = performance.now() - started;
        const residualChildCount = await teardown(worker);

        return {
          durationMs,
          metrics: {
            crashRespawnCount: respawns,
            respawnToActivatedMaxMs,
            respawnReadyMisses,
            respawnActivateMisses,
            respawnInvokeMisses,
            reapMisses,
            residualChildCount,
          },
          notes:
            respawnInvokeMisses > 0
              ? `${respawnInvokeMisses} of ${respawns} respawned workers never served an invoke`
              : respawns < RESPAWN_CYCLES
                ? `stopped after ${respawns} of ${RESPAWN_CYCLES} respawns — a killed worker was never reaped`
                : undefined,
        };
      } finally {
        worker.kill();
      }
    },
  },
  {
    id: "PERF-225",
    name: "Forge Plugin Cold Activation (descriptor to bound impl)",
    description:
      "Cold-activate a forge-contributing plugin through the real activatePluginForForgeProvider path and prove the provider impl actually bound. Forge descriptors register eagerly from the manifest while impls bind only during activate(), so a lazy plugin that is never activated leaves the registry looking populated and routing nothing — the shape of a real shipped bug. The corpus plugin is loaded as a built-in because that is the path plugins/builtin/github takes; Electron's utilityProcess is inert here, so the user-plugin worker route is out of frame.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["eagerBindMisses", "forgeImplMisses", "providerMatchMisses", "descriptorMisses"],
    async run() {
      const corpus = pluginCorpus();
      const child = spawnPluginServiceHost();
      try {
        const init = await child.init(corpus, SERVICE_INIT_TIMEOUT_MS);
        const activation = init
          ? await child.activateForge(FORGE_PROVIDER_ID, SERVICE_COMMAND_TIMEOUT_MS)
          : null;
        if (!init || !activation) {
          return failClosed(`forge activation never ran: ${child.stderr.slice(-400)}`, {
            eagerBindMisses: 0,
            forgeImplMisses: 1,
            providerMatchMisses: 1,
            descriptorMisses: corpus.expected.forgeDescriptors,
            forgeDescriptorCount: 0,
            forgeImplCount: 0,
            residualChildCount: await teardown(child),
          });
        }

        const residualChildCount = await teardown(child);

        return {
          durationMs: activation.activateMs,
          metrics: {
            // The scan cost that precedes the activation, reported alongside so
            // a faster activation bought by a slower scan is visible.
            initializeMs: init.initializeMs,
            forgeDescriptorCount: activation.descriptorCount,
            forgeImplCount: activation.forgeImplCountAfter,
            providerMatchCount: activation.matchCount,
            // Zero before activation, one after: an impl that is already bound
            // when nothing has activated means the count is not measuring
            // activation at all.
            eagerBindMisses: init.forgeImplCountBeforeActivate + activation.forgeImplCountBefore,
            forgeImplMisses: activation.implBound ? 0 : 1,
            // The descriptor is only useful if the registry will route to it.
            providerMatchMisses: activation.matchCount === 1 ? 0 : 1,
            descriptorMisses: Math.abs(
              corpus.expected.forgeDescriptors - activation.descriptorCount
            ),
            residualChildCount,
          },
          notes: activation.implBound
            ? undefined
            : "forge descriptor present but no impl bound after activation",
        };
      } finally {
        child.kill();
      }
    },
  },
];

/** Re-exported so the unit test can name the gate rows without a second copy. */
export { CONSENT_PLUGIN_ID, EXPECTED_CONSENT_LADDER, EXPECTED_STATIC_GATE };
