import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../../shared/types/plugin.js";
import type { ForgeProviderContribution } from "../../../../shared/types/forge.js";
import {
  clearForgeProviderRegistry,
  listMatchingProviders,
  registerForgeProviders,
} from "../../forgeProviderRegistry.js";
import {
  PluginContributionRegistrar,
  type PluginContributionRegistrarDeps,
} from "../PluginContributionRegistrar.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "daintree.github";
const CONTRIBUTION: ForgeProviderContribution = {
  id: "github",
  name: "GitHub",
  matches: ["github.com"],
  matchesSettingRef: "enterpriseHost",
};

function makeRegistrar(
  readUserSetting: PluginContributionRegistrarDeps["readUserSetting"],
  contribution: ForgeProviderContribution = CONTRIBUTION
) {
  const plugin = {
    manifest: { contributes: { forgeProviders: [contribution] } } as unknown as PluginManifest,
  } as unknown as LoadedPlugin;
  const notifyForgeProviderRegistryUpdated = vi.fn();
  const broadcastProvenanceChanged = vi.fn();
  const registrar = new PluginContributionRegistrar({
    broadcaster: { broadcastProvenanceChanged },
    getLoadedPlugin: (id: string) => (id === PLUGIN_ID ? plugin : undefined),
    isCurrent: (id: string, candidate: LoadedPlugin) => id === PLUGIN_ID && candidate === plugin,
    getWorkspaceClient: () => ({ notifyForgeProviderRegistryUpdated }),
    readUserSetting,
  } as unknown as PluginContributionRegistrarDeps);
  return { registrar, notifyForgeProviderRegistryUpdated, broadcastProvenanceChanged };
}

afterEach(() => {
  clearForgeProviderRegistry();
});

describe("PluginContributionRegistrar — setting-backed forge hostnames (#17324)", () => {
  it("routes the hostname a changed setting now names and wakes workspace hosts", async () => {
    registerForgeProviders(PLUGIN_ID, [CONTRIBUTION]);
    const { registrar, notifyForgeProviderRegistryUpdated, broadcastProvenanceChanged } =
      makeRegistrar(async () => "github.example.com");

    await registrar.refreshForgeSettingMatches(PLUGIN_ID);

    expect(listMatchingProviders("https://github.example.com/team/app")).toHaveLength(1);
    expect(notifyForgeProviderRegistryUpdated).toHaveBeenCalledTimes(1);
    // The renderer re-resolves open projects on this, so a GHES project opened
    // before its host was set shows its forge without a reload.
    expect(broadcastProvenanceChanged).toHaveBeenCalledTimes(1);

    // A refresh that changes nothing (another setting changed) tells no one.
    await registrar.refreshForgeSettingMatches(PLUGIN_ID);
    expect(notifyForgeProviderRegistryUpdated).toHaveBeenCalledTimes(1);
    expect(broadcastProvenanceChanged).toHaveBeenCalledTimes(1);
  });

  it("lets the newest of two overlapping reads win", async () => {
    registerForgeProviders(PLUGIN_ID, [CONTRIBUTION]);
    let releaseFirst: (value: unknown) => void = () => {};
    const reads = [
      new Promise<unknown>((resolve) => {
        releaseFirst = resolve;
      }),
      Promise.resolve("ghe.new.example"),
    ];
    const { registrar } = makeRegistrar(() => reads.shift()!);

    const first = registrar.refreshForgeSettingMatches(PLUGIN_ID);
    await registrar.refreshForgeSettingMatches(PLUGIN_ID);
    releaseFirst("ghe.old.example");
    await first;

    expect(listMatchingProviders("https://ghe.new.example/team/app")).toHaveLength(1);
    expect(listMatchingProviders("https://ghe.old.example/team/app")).toEqual([]);
  });

  it("matches only the manifest hostnames when the setting can't be read", async () => {
    registerForgeProviders(PLUGIN_ID, [CONTRIBUTION], {
      settingMatches: new Map([["github", "github.example.com"]]),
    });
    const { registrar } = makeRegistrar(async () => {
      throw new Error("unreadable");
    });

    await registrar.refreshForgeSettingMatches(PLUGIN_ID);

    expect(listMatchingProviders("https://github.example.com/team/app")).toEqual([]);
    expect(listMatchingProviders("https://github.com/team/app")).toHaveLength(1);
  });

  it("reads nothing for a plugin whose forge providers name no setting", async () => {
    const readUserSetting = vi.fn();
    const { matchesSettingRef: _ref, ...plain } = CONTRIBUTION;
    const { registrar, notifyForgeProviderRegistryUpdated } = makeRegistrar(readUserSetting, plain);

    await registrar.refreshForgeSettingMatches(PLUGIN_ID);

    expect(readUserSetting).not.toHaveBeenCalled();
    expect(notifyForgeProviderRegistryUpdated).not.toHaveBeenCalled();
  });
});
