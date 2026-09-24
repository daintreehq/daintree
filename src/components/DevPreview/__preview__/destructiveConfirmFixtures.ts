import type {
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
} from "@shared/types/ipc/devPreview";

/**
 * States of the dev preview's destructive confirm — "Restart and clear cache" and
 * "Reinstall dependencies" — as the two bridge reads behind it resolve.
 *
 * Type imports only: the screenshot spec imports this module under Playwright's
 * Node loader. Modification times are ages in ms, turned into timestamps by the
 * preview page so the relative labels stay stable whenever the capture runs.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

export type DirAge = number | null;

export interface DestructiveConfirmFixture {
  tier: "restartAndClearCache" | "reinstallAndRestart";
  /** `hang` never settles, `error` rejects, otherwise the resolved value. */
  meta:
    | "hang"
    | "error"
    | (Omit<DevPreviewDestructivePreviewMeta, "cacheDirs" | "nodeModules"> & {
        cacheDirs: { relPath: string; age: DirAge }[];
        nodeModulesAge: DirAge;
      });
  sizes: "hang" | "error" | DevPreviewDestructivePreviewSizes;
  /** The confirmed operation is running. */
  confirming?: boolean;
  /** A keyboard drive the spec performs after load. */
  drive?: "tab-to-confirm";
}

const CWD = "/Users/you/code/orchid-studio";

const CACHE_DIRS_POPULATED = [
  { relPath: ".next", age: 2 * HOUR },
  { relPath: ".vite", age: null },
  { relPath: ".turbo", age: 3 * DAY },
  { relPath: ".svelte-kit", age: null },
  { relPath: ".astro", age: null },
  { relPath: ".nuxt", age: null },
  { relPath: "node_modules/.vite", age: 5 * MIN },
];

const CACHE_DIRS_NONE = CACHE_DIRS_POPULATED.map((d) => ({ ...d, age: null }));

const CACHE_SIZES: DevPreviewDestructivePreviewSizes = {
  cacheDirSizes: {
    ".next": 184.3 * MB,
    ".vite": null,
    ".turbo": 41.7 * MB,
    ".svelte-kit": null,
    ".astro": null,
    ".nuxt": null,
    "node_modules/.vite": 12.2 * MB,
  },
  nodeModulesSizeBytes: null,
};

function metaFor(
  overrides: Partial<Exclude<DestructiveConfirmFixture["meta"], "hang" | "error">> = {}
): Exclude<DestructiveConfirmFixture["meta"], "hang" | "error"> {
  return {
    cwd: CWD,
    cacheDirs: CACHE_DIRS_POPULATED,
    nodeModulesAge: 6 * DAY,
    packageManager: "npm",
    lockfileName: "package-lock.json",
    ...overrides,
  };
}

const reinstallSizes = (bytes: number | null): DevPreviewDestructivePreviewSizes => ({
  cacheDirSizes: {},
  nodeModulesSizeBytes: bytes,
});

export const DESTRUCTIVE_FIXTURES = {
  "cache-populated": { tier: "restartAndClearCache", meta: metaFor(), sizes: CACHE_SIZES },
  "cache-sizing": { tier: "restartAndClearCache", meta: metaFor(), sizes: "hang" },
  "cache-loading": { tier: "restartAndClearCache", meta: "hang", sizes: "hang" },
  "cache-none": {
    tier: "restartAndClearCache",
    meta: metaFor({ cacheDirs: CACHE_DIRS_NONE }),
    sizes: { cacheDirSizes: {}, nodeModulesSizeBytes: null },
  },
  "cache-sizes-failed": { tier: "restartAndClearCache", meta: metaFor(), sizes: "error" },
  "cache-error": { tier: "restartAndClearCache", meta: "error", sizes: "error" },
  "reinstall-npm": {
    tier: "reinstallAndRestart",
    meta: metaFor(),
    sizes: reinstallSizes(612.4 * MB),
  },
  "reinstall-pnpm": {
    tier: "reinstallAndRestart",
    meta: metaFor({ packageManager: "pnpm", lockfileName: "pnpm-lock.yaml" }),
    sizes: reinstallSizes(488.9 * MB),
  },
  "reinstall-sizing": { tier: "reinstallAndRestart", meta: metaFor(), sizes: "hang" },
  "reinstall-loading": { tier: "reinstallAndRestart", meta: "hang", sizes: "hang" },
  "reinstall-absent": {
    tier: "reinstallAndRestart",
    meta: metaFor({ packageManager: "yarn", lockfileName: "yarn.lock", nodeModulesAge: null }),
    sizes: reinstallSizes(null),
  },
  "reinstall-no-lockfile": {
    tier: "reinstallAndRestart",
    meta: metaFor({ lockfileName: null }),
    sizes: reinstallSizes(97.1 * MB),
  },
  "reinstall-long-path": {
    tier: "reinstallAndRestart",
    meta: metaFor({
      cwd: "/Users/you/code/clients/northwind-traders/monorepo-2026/packages/storefront-web-app",
      packageManager: "bun",
      lockfileName: "bun.lockb",
    }),
    sizes: reinstallSizes(1.9 * 1024 * MB),
  },
  "reinstall-error": { tier: "reinstallAndRestart", meta: "error", sizes: "error" },
  "reinstall-confirming": {
    tier: "reinstallAndRestart",
    meta: metaFor(),
    sizes: reinstallSizes(612.4 * MB),
    confirming: true,
  },
  "reinstall-keyboard": {
    tier: "reinstallAndRestart",
    meta: metaFor(),
    sizes: reinstallSizes(612.4 * MB),
    drive: "tab-to-confirm",
  },
} satisfies Record<string, DestructiveConfirmFixture>;

export type DestructiveFixtureName = keyof typeof DESTRUCTIVE_FIXTURES;
export const DESTRUCTIVE_FIXTURE_NAMES =
  Object.keys(DESTRUCTIVE_FIXTURES).filter(isDestructiveFixtureName);

export function isDestructiveFixtureName(value: string): value is DestructiveFixtureName {
  return Object.prototype.hasOwnProperty.call(DESTRUCTIVE_FIXTURES, value);
}
