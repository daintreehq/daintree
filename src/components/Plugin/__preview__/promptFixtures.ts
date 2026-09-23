import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { PluginQuickPickItem } from "@shared/types/plugin";
import type { PluginUiPromptParams } from "@shared/types/pluginUiPrompt";

/**
 * A project-owned plugin, so the raw id is the instance key a person must never
 * see. The runtime store names it; every capture proves the name won.
 */
export const PROMPT_PLUGIN_ID = "project__b6700c7a__acme.release-helper";
const PROMPT_PLUGIN_NAME = "Release Helper";

const BRANCHES: PluginQuickPickItem[] = [
  { id: "main", label: "main" },
  { id: "develop", label: "develop" },
  { id: "release-2-4", label: "release/2.4" },
  { id: "feature-oauth", label: "feature/oauth-device-flow" },
  { id: "fix-backoff", label: "fix/retry-backoff-jitter" },
  { id: "chore-deps", label: "chore/bump-electron-42" },
];

const ENVIRONMENTS: PluginQuickPickItem[] = [
  {
    id: "production",
    label: "Production",
    description: "us-east-1",
    detail: "Last deployed 2 hours ago by Priya · v2.4.1",
  },
  {
    id: "staging",
    label: "Staging",
    description: "us-east-1",
    detail: "Last deployed 14 minutes ago by CI · v2.5.0-rc.3",
  },
  {
    id: "preview",
    label: "Preview",
    description: "per-branch",
    detail: "Spins up an ephemeral environment for the current branch",
  },
  { id: "local", label: "Local", description: "docker compose" },
  { id: "canary", label: "Canary", detail: "5% of production traffic" },
];

const CHECKS: PluginQuickPickItem[] = [
  { id: "lint", label: "Lint", description: "eslint + prettier" },
  { id: "types", label: "Typecheck", description: "tsc -b" },
  { id: "unit", label: "Unit tests", description: "vitest, 4 shards" },
  { id: "e2e", label: "End-to-end tests", description: "playwright, ~12 min" },
  { id: "bundle", label: "Bundle budget", description: "renderer chunks" },
];

const LONG: PluginQuickPickItem[] = [
  {
    id: "long-1",
    label:
      "packages/release-helper/src/pipelines/production/eu-west-1/blue-green/cutover-with-database-migration.yaml",
    description: "modified 3 minutes ago in feature/oauth-device-flow by a very long author name",
    detail:
      "Runs the blue-green cutover, applies pending migrations, warms the cache, then shifts traffic in 10% steps with automatic rollback on a failed health check",
  },
  {
    id: "long-2",
    label: "Deploy",
    description: "a short label with a description that goes on well past the width of the palette",
  },
  { id: "long-3", label: "Rollback", detail: "Reverts to the previous release tag" },
];

function seedName(): void {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([
      [PROMPT_PLUGIN_ID, { devMode: false, displayName: PROMPT_PLUGIN_NAME }],
    ]),
  });
}

function prompt(params: PluginUiPromptParams): void {
  seedName();
  usePluginPromptStore.getState().enqueue({
    promptId: "preview-prompt",
    pluginId: PROMPT_PLUGIN_ID,
    params,
    resolve: (value) => {
      Reflect.set(window, "__promptResult", value === undefined ? "<undefined>" : value);
    },
  });
}

export interface PromptFixture {
  what: string;
  seed: () => void;
}

export const PROMPT_FIXTURES: Record<string, PromptFixture> = {
  "qp-basic": {
    what: "title, placeholder, label-only rows",
    seed: () =>
      prompt({
        kind: "quickPick",
        items: BRANCHES,
        options: { title: "Choose a branch to release", placeholder: "Filter branches" },
      }),
  },
  "qp-defaults": {
    what: "no options at all: the host's fallback title and placeholder",
    seed: () => prompt({ kind: "quickPick", items: BRANCHES.slice(0, 4), options: {} }),
  },
  "qp-rich": {
    what: "description beside the label, detail beneath it",
    seed: () =>
      prompt({
        kind: "quickPick",
        items: ENVIRONMENTS,
        options: {
          title: "Deploy to which environment?",
          placeholder: "Search environments",
          matchOnDescription: true,
        },
      }),
  },
  "qp-long": {
    what: "labels, descriptions and details past the palette width",
    seed: () =>
      prompt({
        kind: "quickPick",
        items: LONG,
        options: {
          title:
            "Pick the pipeline definition to run against the production cluster in eu-west-1 tonight",
          placeholder: "Search pipelines, environments, owners and anything else",
        },
      }),
  },
  "qp-multi": {
    what: "canSelectMany; the spec checks rows",
    seed: () =>
      prompt({
        kind: "quickPick",
        items: CHECKS,
        options: { title: "Run which checks before release?", canSelectMany: true },
      }),
  },
  "qp-empty": {
    what: "the plugin sent no items",
    seed: () =>
      prompt({ kind: "quickPick", items: [], options: { title: "Choose a release tag" } }),
  },
  "ib-full": {
    what: "title, prompt and placeholder, empty value",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: {
          title: "Name the release",
          prompt: "Used as the tag and the GitHub release title.",
          placeholder: "v2.5.0",
        },
      }),
  },
  "ib-prefilled": {
    what: "a pre-filled value",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: {
          title: "Name the release",
          prompt: "Used as the tag and the GitHub release title.",
          placeholder: "v2.5.0",
          value: "v2.5.0-rc.4",
        },
      }),
  },
  "ib-defaults": {
    what: "no options at all",
    seed: () => prompt({ kind: "inputBox", options: {} }),
  },
  "ib-password": {
    what: "a masked prompt for a secret — the phishing shape",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: {
          title: "Enter your GitHub token",
          prompt: "Paste a personal access token with the repo scope.",
          placeholder: "ghp_…",
          password: true,
        },
      }),
  },
  "ib-invalid": {
    what: "pattern + message; the spec submits a bad value",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: {
          title: "Name the release",
          prompt: "Used as the tag and the GitHub release title.",
          placeholder: "v2.5.0",
          validationPattern: "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$",
          validationMessage: "Use a semver tag like v2.5.0",
        },
      }),
  },
  "ib-invalid-default": {
    what: "pattern, no message: the host's fallback copy",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: { title: "Ticket number", validationPattern: "^[A-Z]+-\\d+$" },
      }),
  },
  "ib-long": {
    what: "title and prompt that wrap",
    seed: () =>
      prompt({
        kind: "inputBox",
        options: {
          title: "Describe what changed in this release for the changelog and the announcement post",
          prompt:
            "This text goes into CHANGELOG.md under the new version heading, and into the draft GitHub release. Markdown is fine. Keep it to a sentence or two; the full list of merged pull requests is added automatically underneath it.",
          placeholder: "Faster cold start, and the new deploy panel",
        },
      }),
  },
  "cf-default": {
    what: "the sibling confirm prompt, for the provenance line",
    seed: () =>
      prompt({
        kind: "confirm",
        options: {
          title: "Publish release v2.5.0?",
          message: "Pushes the tag and publishes the draft GitHub release.",
          confirmLabel: "Publish release",
        },
      }),
  },
  "cf-destructive": {
    what: "the sibling confirm prompt, destructive",
    seed: () =>
      prompt({
        kind: "confirm",
        options: {
          title: "Delete tag 'v2.5.0-rc.3'?",
          message: "Removes the tag locally and on origin.",
          confirmLabel: "Delete tag",
          destructive: true,
        },
      }),
  },
};

export function requirePromptFixture(name: string): PromptFixture {
  const fixture = PROMPT_FIXTURES[name];
  if (!fixture) {
    throw new Error(
      `unknown plugin-prompt fixture "${name}" — one of ${Object.keys(PROMPT_FIXTURES).join(", ")}`
    );
  }
  return fixture;
}
