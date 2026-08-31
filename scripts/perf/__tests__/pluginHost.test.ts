import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ECHO_ACTION,
  EXPECTED_CONSENT_LADDER,
  EXPECTED_STATIC_GATE,
  FIXTURE_ACTION_COUNT,
  FORGE_PLUGIN_ID,
  FORGE_PROVIDER_ID,
  HOST_CALL_ACTION,
  expectedRegistrationKeys,
  livePluginChildCount,
  missingRegistrationCount,
  nonce,
  pluginCorpus,
  workerFixtureBundle,
  type PluginWorker,
} from "../lib/pluginHostFixture";
import { pluginHostScenarios } from "../scenarios/pluginHost";

/**
 * Unit coverage for the corpus generator and the gate expectation tables only.
 * The scenarios themselves fork the real plugin worker and a real
 * `PluginService`, and are exercised by `npm run perf`, not by vitest — booting
 * the plugin subsystem per shard would cost more than it proves.
 *
 * What is worth testing here is the ORACLE. Every predicate in this family
 * compares what the subject produced against a declaration in the parent, so a
 * declaration that quietly stops describing the corpus turns four miss counts
 * into decoration that reports zero forever.
 */
describe("plugin corpus", () => {
  it("declares contribution totals that match the corpus it writes", () => {
    const corpus = pluginCorpus();

    expect(corpus.manifestDirCount).toBe(corpus.validCount + corpus.invalidCount);
    // Four schema violations plus the reserved-namespace claim.
    expect(corpus.invalidCount).toBe(5);
    expect(corpus.validCount).toBeGreaterThan(0);

    // Read back off disk rather than off the spec: the counts are the
    // scenario's oracle, and an oracle derived from the same object it grades
    // proves nothing.
    const manifest = JSON.parse(
      readFileSync(`${corpus.builtinRoot}/${FORGE_PLUGIN_ID}/plugin.json`, "utf8")
    ) as { contributes: Record<string, unknown[]>; name: string };
    expect(manifest.name).toBe(FORGE_PLUGIN_ID);
    expect(corpus.expected.panelKinds).toBe(corpus.validCount * manifest.contributes.panels.length);
    expect(corpus.expected.toolbarButtons).toBe(corpus.validCount);
    expect(corpus.expected.keybindings).toBe(corpus.validCount);
    expect(corpus.expected.contextMenus).toBe(corpus.validCount);
    expect(corpus.expected.agents).toBe(corpus.validCount);
    // Only the built-in root contributes forge providers; the user-root
    // plugins deliberately do not, so this must be strictly smaller.
    expect(corpus.expected.forgeDescriptors).toBeGreaterThan(0);
    expect(corpus.expected.forgeDescriptors).toBeLessThan(corpus.validCount);
  });

  it("writes a reserved-namespace manifest into the USER root, where it must be refused", () => {
    const corpus = pluginCorpus();
    // In the built-in root the same name is legal, so putting it there would
    // turn the reject case into an accept case without changing a number.
    expect(existsSync(`${corpus.userRoot}/daintree.perfreserved/plugin.json`)).toBe(true);
    expect(existsSync(`${corpus.builtinRoot}/daintree.perfreserved/plugin.json`)).toBe(false);
  });

  it("names the forge provider as the product namespaces it", () => {
    expect(FORGE_PROVIDER_ID).toBe(`${FORGE_PLUGIN_ID}.prov`);
  });

  it("is memoized, so an iteration prices the scan and not the writes", () => {
    expect(pluginCorpus()).toBe(pluginCorpus());
  });
});

describe("worker fixture plugin", () => {
  it("registers exactly the ids the registration oracle expects", () => {
    const bundle = workerFixtureBundle();
    const source = readFileSync(bundle, "utf8");

    const keys = expectedRegistrationKeys("acme.demo");
    // Two named actions plus one bulk action and one bulk handler per slot.
    expect(keys.size).toBe(2 + FIXTURE_ACTION_COUNT * 2);
    expect(keys.has(`action:acme.demo.${ECHO_ACTION}`)).toBe(true);
    expect(keys.has(`action:acme.demo.${HOST_CALL_ACTION}`)).toBe(true);
    expect(keys.has(`handler:bulk-channel-0`)).toBe(true);

    // The keys are the product's own `action:`/`handler:` registrationKey form,
    // so they only match if the bundle really registers those surfaces.
    expect(source).toContain("registerAction");
    expect(source).toContain("registerHandler");
    expect(source).toContain("registerFileDecorationProvider");
    expect(source).toContain(ECHO_ACTION);
    expect(source).toContain(HOST_CALL_ACTION);
  });

  it("scores a registration forward that never arrived", () => {
    const keys = [...expectedRegistrationKeys("acme.demo")];
    const complete = {
      registrations: keys.map((key) => ({ method: "registerAction", registrationKey: key })),
    } as unknown as PluginWorker;
    expect(missingRegistrationCount(complete, "acme.demo")).toBe(0);

    // The shape the oracle exists for: a worker that boots, activates, returns
    // its disposer and exits zero, having forwarded nothing.
    const silent = { registrations: [] } as unknown as PluginWorker;
    expect(missingRegistrationCount(silent, "acme.demo")).toBe(keys.length);

    // A registration that arrived without its key is not evidence it happened.
    const keyless = {
      registrations: keys.map(() => ({ method: "registerAction", registrationKey: null })),
    } as unknown as PluginWorker;
    expect(missingRegistrationCount(keyless, "acme.demo")).toBe(keys.length);
  });

  it("mints nonces long enough to be a real payload check", () => {
    const a = nonce("perf-223-0");
    const b = nonce("perf-223-0");
    expect(a).not.toBe(b);
    expect(a.startsWith("perf-223-0-")).toBe(true);
    expect(a.length).toBe("perf-223-0-".length + 64);
  });
});

describe("gate expectation tables", () => {
  it("grades both directions, so neither a fail-open nor a fail-closed gate scores well", () => {
    const staticAllows = EXPECTED_STATIC_GATE.filter((row) => row.allowed);
    const staticDenies = EXPECTED_STATIC_GATE.filter((row) => !row.allowed);
    expect(staticAllows.length).toBeGreaterThan(0);
    expect(staticDenies.length).toBeGreaterThan(0);

    // A gate that denies everything passes a deny-only table perfectly.
    const consentAllows = EXPECTED_CONSENT_LADDER.filter((row) => row.allowed);
    const consentDenies = EXPECTED_CONSENT_LADDER.filter((row) => !row.allowed);
    expect(consentAllows.length).toBeGreaterThan(0);
    expect(consentDenies.length).toBeGreaterThan(0);
  });

  it("distinguishes the three refusal reasons, so a TypeError cannot read as a clean deny", () => {
    const kinds = new Set(EXPECTED_STATIC_GATE.map((row) => row.denialKind));
    expect(kinds.has("capability")).toBe(true);
    expect(kinds.has("containment")).toBe(true);
    expect([...EXPECTED_CONSENT_LADDER].some((row) => row.denialKind === "consent")).toBe(true);
    // "other" is what an arity drift or an unexpected throw classifies as, and
    // no row may expect it — that is the point of the kind check.
    expect(kinds.has("other")).toBe(false);
  });

  it("runs the consent ladder unbridged first, then bridged, then unbridged again", () => {
    // Order is load-bearing: the last row can only pass on a persisted grant,
    // and it only proves that if the bridge is gone by the time it runs.
    expect(EXPECTED_CONSENT_LADDER.map((row) => row.allowed)).toEqual([false, false, true, true]);
  });
});

describe("plugin host scenario family", () => {
  it("covers the declared ids", () => {
    expect(pluginHostScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-220",
      "PERF-221",
      "PERF-222",
      "PERF-223",
      "PERF-224",
      "PERF-225",
    ]);
  });

  it("pairs every scenario with a miss count and runs each one in smoke", () => {
    for (const scenario of pluginHostScenarios) {
      expect(scenario.correctness?.length ?? 0).toBeGreaterThan(0);
      expect(scenario.modes).toContain("smoke");
    }
  });

  it("predicates registrations wherever the worker is activated", () => {
    // Boot, activation, cleanup and dispose all pass against a host that
    // forwards no registrations at all, so both scenarios that activate the
    // fixture plugin have to grade what arrived against what it owed.
    for (const id of ["PERF-220", "PERF-223"]) {
      const scenario = pluginHostScenarios.find((entry) => entry.id === id);
      expect(scenario?.correctness).toContain("registrationMisses");
    }
  });

  it("importing the family forks no plugin children", () => {
    // Lazy-fixture rule: a worker or service child is forked inside run(),
    // never at import time.
    expect(livePluginChildCount()).toBe(0);
  });
});
