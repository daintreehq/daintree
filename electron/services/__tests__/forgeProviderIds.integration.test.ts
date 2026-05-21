/**
 * End-to-end proof that the canonical forge provider id (#8451) the registry
 * builds from the on-disk built-in plugin manifest is the same canonical id
 * the resolver returns, and the same one the read-boundary normalizer arrives
 * at from any of the legacy alias forms. Loads the real
 * `plugins/builtin/github/plugin.json` so a future rename of either the plugin
 * or its contribution would surface here as a failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_GITHUB_PROVIDER_ID,
  makeForgeProviderId,
  normalizeProviderId,
} from "../../../shared/utils/forgeProviderIds.js";
import {
  clearForgeProviderImplRegistry,
  clearForgeProviderRegistry,
  registerForgeProviders,
} from "../forgeProviderRegistry.js";
import { resolveForgeProvider } from "../forgeProviderResolver.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(HERE, "../../../plugins/builtin/github/plugin.json");

interface BuiltInGitHubManifest {
  name: string;
  contributes: {
    forgeProviders: Array<{
      id: string;
      name: string;
      matches: string[];
      capabilities?: string[];
    }>;
  };
}

function loadBuiltInGitHubManifest(): BuiltInGitHubManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as BuiltInGitHubManifest;
}

beforeEach(() => {
  clearForgeProviderRegistry();
  clearForgeProviderImplRegistry();
});

describe("forge provider canonical id (real built-in GitHub plugin)", () => {
  it("matches what the manifest declares + helper computes", () => {
    const manifest = loadBuiltInGitHubManifest();
    const contribution = manifest.contributes.forgeProviders[0];
    expect(contribution).toBeDefined();
    expect(makeForgeProviderId(manifest.name, contribution.id)).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("registers the manifest and resolves a github.com remote to the canonical id", () => {
    const manifest = loadBuiltInGitHubManifest();
    registerForgeProviders(manifest.name, manifest.contributes.forgeProviders);

    const resolved = resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });

    expect(resolved.entry).not.toBeNull();
    const { pluginId, contribution } = resolved.entry!;
    expect(makeForgeProviderId(pluginId, contribution.id)).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(resolved.resolvedVia).toBe("hostname");
  });

  it("resolves an override stored as the canonical id", () => {
    const manifest = loadBuiltInGitHubManifest();
    registerForgeProviders(manifest.name, manifest.contributes.forgeProviders);

    const resolved = resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: BUILTIN_GITHUB_PROVIDER_ID,
      globalDefaultProviderId: null,
    });

    expect(resolved.entry).not.toBeNull();
    const { pluginId, contribution } = resolved.entry!;
    expect(makeForgeProviderId(pluginId, contribution.id)).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(resolved.resolvedVia).toBe("override");
  });

  it("normalizes every legacy alias to the same canonical id the resolver returns", () => {
    expect(normalizeProviderId("github")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(normalizeProviderId("builtin.github")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(normalizeProviderId(BUILTIN_GITHUB_PROVIDER_ID)).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });
});
