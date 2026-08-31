import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import nodeModule from "node:module";
import { delimiter, join } from "node:path";

import type { AgentConfig } from "../../../shared/config/agentRegistry";
import type { CliAvailability } from "../../../shared/types/ipc";
import { createPerfTempRoot } from "./tempRoots";

/**
 * The REAL CLI-availability probe storm for PERF-393..394, driven hermetically.
 *
 * `useAgentSetupPoll` calls `cliAvailabilityClient.refresh()` on a **3-second
 * interval** for as long as the agent setup wizard is open, and `refresh()` is
 * the cache-BYPASSING entry point: it bumps `checkId`, drops any in-flight
 * check, and re-probes all 18 agents from scratch. Every probe that misses runs
 * `which -a <cmd>` and then, because a non-zero exit is indistinguishable from
 * a `which` that rejects `-a`, `which <cmd>` again — so the first-run
 * worst case is 37 subprocess starts every three seconds, happening exactly
 * while a brand-new user watches the app decide what they have installed.
 * Nothing measured it.
 *
 * WHAT IS REAL
 *   - `electron/services/CliAvailabilityService.ts` unmodified, driven through
 *     its shipped `checkAvailability()` and `refresh()` entry points: the real
 *     `Promise.allSettled` fan-out over the real `getEffectiveRegistry()`, the
 *     real layered `probeCommand` ladder (prepended-path → `which`/`where` →
 *     `nativePaths` → synthesised PyPI paths → npm-global shim → WSL), the real
 *     `checkAuth` credential discovery, the real `dedupePathsByDirectory`
 *     duplicate detection and the real `notifyDuplicateInstalls` persistence.
 *   - Real `which` / `where` subprocesses against a real PATH, and a real
 *     `npm config get prefix` attempt. Every start is counted through the
 *     harness's existing spawn observer in `lib/gitPipelineFixture.ts`, which
 *     validates itself before each measurement window.
 *   - The real 18-entry agent roster from `shared/config/agents/`.
 *
 * WHAT IS NOT, AND WHY
 *   - **`electron/setup/environment.ts` is stubbed**, and this is the load-
 *     bearing decision in the file. `refresh()` awaits `refreshPath()`, which
 *     spawns the user's login shell through `shell-env`, REPLACES
 *     `process.env.PATH` with whatever that shell exports, and then appends
 *     every version-manager shim directory that exists (`/opt/homebrew/bin`,
 *     `~/.local/bin`, mise/asdf/Volta/pnpm/Nix). Running it would put the
 *     developer's own installed agent CLIs on the probed PATH, which is both
 *     non-hermetic and a direct breach of "do not probe the user's real agent
 *     CLIs": the found set would then depend on what happens to be installed on
 *     the machine. The stub keeps the shape — `refresh()` still awaits an async
 *     PATH refresh before probing — assigns the arm's synthetic PATH, and
 *     COUNTS its calls, which `pathRefreshMisses` grades. The cost it removes
 *     is stated rather than hidden: a login-shell probe per refresh is real and
 *     is NOT in these numbers. Its module evaluation also performs SQLite
 *     setup, userData re-pathing and macOS `open-url` listener registration,
 *     none of which belongs inside a probe benchmark.
 *   - **`electron/store.ts` is stubbed** to the two members
 *     `notifyDuplicateInstalls` calls (`get`/`set`). The real module opens an
 *     electron-store JSON file through a corrupt-config preflight; PERF-057/058
 *     price that engine, and it is not what this family measures.
 *   - **`electron` is stubbed** to an inert stand-in, so `broadcastToRenderer`
 *     iterates an empty window list. The duplicate-install toast is therefore
 *     built and dispatched but never painted.
 *   - **`HOME` is repointed at an empty temp directory**, so `probeNativePaths`,
 *     the synthesised PyPI paths and `checkAuth`'s credential discovery all
 *     probe paths that exist only inside this fixture. Without it, a developer
 *     with `~/.local/bin/claude` installed would see a "found" agent this
 *     fixture never planted.
 *   - **No renderer and no 3-second timer.** The poll interval is a fact about
 *     the wizard, not something this harness sleeps through: PERF-393 runs the
 *     window's refreshes back to back and reports per-refresh cost with the
 *     waiting removed.
 *
 * WINDOWS
 *   Both scenarios are declared `diagnostic` on win32. Two agents (`codex`,
 *   `amp`) declare `supportsWsl`, and their miss path runs `wsl.exe --list
 *   --verbose` and then `wsl.exe -d <distro> -e <cmd> --version` against the
 *   user's REAL WSL installation — which this fixture must not do. So on
 *   win32 those two agents are planted in every arm, which keeps the probe
 *   hermetic and makes the "all miss" arm an "all but the WSL-capable two"
 *   arm. The shell probe also differs (`where.exe`, and no `-a` retry, so a
 *   miss costs one start rather than two), and the expected-spawn arithmetic
 *   below accounts for it — but it has not been executed on Windows.
 *
 * TEMP-DIR HYGIENE
 *   One `mkdtemp` root holds the synthetic HOME, every per-arm bin directory
 *   and the stubbed store's data. It is removed on process exit.
 */

// --- Bridge the stubs read ---------------------------------------------------

interface CliBridge {
  /** PATH the stubbed `refreshPath` assigns. Set per arm. */
  path: string;
  /** `refreshPath()` calls, incremented inside the stub itself. */
  refreshCalls: number;
  /**
   * Keys the stubbed store persisted.
   *
   * `notifyDuplicateInstalls` writes a `duplicate-cli-warning:<agentId>`
   * milestone the first time it sees an agent with two installs, and never
   * again — so this is deliberately NOT a predicate: it is non-zero on the
   * first iteration and zero on every one after, which is exactly the shape a
   * predicate must not have. Kept because it makes the write observable while
   * debugging.
   */
  storedKeys: string[];
}

const BRIDGE_KEY = "__daintreePerfCliAvailabilityBridge";

function getBridge(): CliBridge {
  const host = globalThis as unknown as Record<string, unknown>;
  const existing = host[BRIDGE_KEY];
  if (existing !== undefined) return existing as CliBridge;
  const bridge: CliBridge = { path: "", refreshCalls: 0, storedKeys: [] };
  host[BRIDGE_KEY] = bridge;
  return bridge;
}

const bridge = getBridge();

// --- Temp root ---------------------------------------------------------------

let fixtureRoot: string | null = null;

function ensureCliEnv(): string {
  if (fixtureRoot !== null) return fixtureRoot;
  const root = createPerfTempRoot("daintree-perf-cli-");
  fixtureRoot = root;

  const userData = join(root, "userdata");
  mkdirSync(userData, { recursive: true });
  process.env.DAINTREE_USER_DATA ??= userData;

  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // `os.homedir()` reads $HOME on POSIX and $USERPROFILE on Windows, on every
  // call. Both are repointed so nothing under the developer's real home is
  // stat'd by `probeNativePaths` or `checkAuth`.
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  return root;
}

// --- Module stubs ------------------------------------------------------------

const ELECTRON_STUB_SOURCE = `
const noop = () => undefined;
export const app = {
  isPackaged: false,
  getPath: () => "/tmp/daintree-perf-cli",
  getVersion: () => "0.0.0-perf",
  getName: () => "Daintree",
  on: noop, once: noop, whenReady: () => Promise.resolve(),
};
export const ipcMain = { handle: noop, handleOnce: noop, removeHandler: noop, on: noop, once: noop, removeListener: noop, off: noop, removeAllListeners: noop };
export const session = { defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop }, fromPartition: () => ({ setPermissionRequestHandler: noop, setPermissionCheckHandler: noop }) };
export const BrowserWindow = class { static getAllWindows() { return []; } static fromWebContents() { return null; } };
export const WebContentsView = class {};
export const webContents = { getAllWebContents: () => [], fromId: () => null };
export const shell = { openExternal: noop };
export const dialog = {};
export const net = {};
export const nativeTheme = { on: noop };
export const utilityProcess = { fork: noop };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, session, BrowserWindow, WebContentsView, webContents, shell };
`;

/**
 * The one function `CliAvailabilityService` awaits before probing, and the
 * reason this family needs a stub at all. See the header: the real one puts the
 * developer's own PATH — and therefore their own installed agent CLIs — into
 * the measurement.
 */
const ENVIRONMENT_STUB_SOURCE = `
const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
export async function refreshPath() {
  bridge.refreshCalls += 1;
  process.env.PATH = bridge.path;
}
export function expandWindowsEnvVars(value) { return value; }
export function kickOffEarlyPathRefresh() { return Promise.resolve(); }
export function getEarlyPathRefreshPromise() { return null; }
export const isDemoMode = false;
export const isSmokeTest = false;
`;

const STORE_STUB_SOURCE = `
const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
const data = {};
export const store = {
  get: (key) => data[key],
  set: (key, value) => { data[key] = value; bridge.storedKeys.push(key); },
  delete: (key) => { delete data[key]; },
  has: (key) => Object.hasOwn(data, key),
  onDidChange: () => () => undefined,
};
export default store;
`;

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const ELECTRON_STUB_URL = dataUrl(ELECTRON_STUB_SOURCE);

const STUB_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["/electron/setup/environment", dataUrl(ENVIRONMENT_STUB_SOURCE)],
  ["/electron/store", dataUrl(STORE_STUB_SOURCE)],
];

const HOOKS_SOURCE = `
const ELECTRON_STUB_URL = ${JSON.stringify(ELECTRON_STUB_URL)};
const STUB_TABLE = ${JSON.stringify(STUB_TABLE)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  const withoutExt = String(resolved.url).split("?")[0].replace(/\\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;

function stubUrlFor(resolvedUrl: string): string | null {
  const withoutExt = String(resolvedUrl)
    .split("?")[0]!
    .replace(/\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return url;
  }
  return null;
}

let hooksInstalled = false;

/**
 * Remap `electron`, `setup/environment` and `store` so the availability service
 * loads outside Electron and outside the developer's environment.
 *
 * Mirrors `lib/ipcEnvelopeFixture.ts`: `module.registerHooks` is synchronous
 * and in-thread but landed in Node 22.15 while `.nvmrc` pins 22.13, so
 * `module.register` is the fallback. Under Vitest neither fires because Vite
 * resolves imports itself, which is why the unit test exercises the pure
 * arithmetic rather than loading the service.
 */
function installModuleStubs(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => { url: string }
        ) => { url: string; shortCircuit?: boolean };
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        const resolved = nextResolve(specifier, context);
        const stub = stubUrlFor(resolved.url);
        return stub ? { url: stub, shortCircuit: true } : resolved;
      },
    });
    return;
  }

  nodeModule.register(dataUrl(HOOKS_SOURCE));
}

installModuleStubs();

// --- Registry ----------------------------------------------------------------

/**
 * The agent this fixture NEVER plants, in any arm and on any platform.
 *
 * A one-directional oracle is worthless here: an availability check that
 * answered "ready" for everything would satisfy a found-set test built only
 * from planted agents. `kiro` carries no npm package, no PyPI package, no
 * `nativePaths` and no WSL support, so its miss path is the plain shell probe
 * and its expected spawn cost is exact.
 */
export const ALWAYS_ABSENT_AGENT_ID = "kiro";

/** The agent given a second install, so duplicate detection has a subject. */
export const DUPLICATE_AGENT_ID = "claude";

type RegistryModule = typeof import("../../../shared/config/agentRegistry");
type ServiceModule = typeof import("../../../electron/services/CliAvailabilityService");

export interface CliModules {
  registry: Record<string, AgentConfig>;
  agentIds: readonly string[];
  CliAvailabilityService: ServiceModule["CliAvailabilityService"];
}

let modulesPromise: Promise<CliModules> | null = null;

export function loadCliModules(): Promise<CliModules> {
  if (modulesPromise === null) {
    ensureCliEnv();
    modulesPromise = (async () => {
      const registryModule: RegistryModule = await import("../../../shared/config/agentRegistry");
      const serviceModule: ServiceModule =
        await import("../../../electron/services/CliAvailabilityService");
      const registry = registryModule.getEffectiveRegistry();
      return {
        registry,
        agentIds: Object.keys(registry),
        CliAvailabilityService: serviceModule.CliAvailabilityService,
      };
    })();
  }
  return modulesPromise;
}

// --- Shims -------------------------------------------------------------------

const isWindows = process.platform === "win32";

/** System directories the probe binaries themselves live in. */
function systemPathDirs(): string[] {
  if (isWindows) {
    const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    return [join(root, "System32")];
  }
  return ["/usr/bin", "/bin"];
}

function shimNamesFor(command: string): string[] {
  // `where.exe` resolves through PATHEXT, and `probePrependedCliPath` tries the
  // `.cmd` spelling first on Windows.
  return isWindows ? [`${command}.cmd`] : [command];
}

function plantShim(dir: string, command: string): void {
  for (const name of shimNamesFor(command)) {
    const path = join(dir, name);
    writeFileSync(path, isWindows ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWindows) chmodSync(path, 0o755);
  }
}

// --- Arms --------------------------------------------------------------------

export type CliArmLabel = "allMiss" | "half" | "allHit" | "prepend";

export interface CliArm {
  label: CliArmLabel;
  /** Agent ids whose shim this arm planted. The found-set oracle's expectation. */
  plantedIds: readonly string[];
  /** PATH this arm's `refreshPath` stub assigns. */
  path: string;
  /** `DAINTREE_CLI_PATH_PREPEND` for this arm, or null. */
  prepend: string | null;
  /** Subprocess starts one `refresh()` on this arm must make. */
  expectedSpawns: number;
  /** True when this arm plants a second install for {@link DUPLICATE_AGENT_ID}. */
  hasDuplicate: boolean;
}

/**
 * Agents that must be planted on every arm on Windows, because their miss path
 * reaches the user's real WSL installation. Empty everywhere else.
 */
function forcedPlantIds(registry: Record<string, AgentConfig>): string[] {
  if (!isWindows) return [];
  return Object.entries(registry)
    .filter(([, config]) => config.supportsWsl === true)
    .map(([id]) => id);
}

function hasNpmPackage(config: AgentConfig): boolean {
  return (config.packages?.npm ?? config.npmGlobalPackage) !== undefined;
}

/**
 * Subprocess starts one cache-bypassing `refresh()` costs, computed from this
 * fixture's own planting decisions and the registry's declared package data.
 *
 * Never derived by running the subject. On POSIX:
 *   - a hit found through `DAINTREE_CLI_PATH_PREPEND` costs 0 — the prepended
 *     probe is an `access()` and returns before any subprocess
 *   - a hit found on PATH costs 1: `which -a <cmd>`
 *   - a miss costs 2: `which -a <cmd>` exits non-zero, and the service cannot
 *     tell "not installed" from "this `which` rejects `-a`", so it runs
 *     `which <cmd>` again
 *   - plus 1 for `npm config get prefix`, once per refresh (it is cached
 *     against `checkId`, which `refresh()` bumps), if any MISSING agent
 *     declares an npm package
 * On Windows `where.exe` already prints every match, so there is no retry and a
 * miss costs 1.
 */
export function expectedSpawnsFor(
  registry: Record<string, AgentConfig>,
  plantedIds: readonly string[],
  viaPrepend: boolean
): number {
  const planted = new Set(plantedIds);
  const missPerAgent = isWindows ? 1 : 2;
  let total = 0;
  let missingDeclaresNpm = false;

  for (const [id, config] of Object.entries(registry)) {
    if (planted.has(id)) {
      total += viaPrepend ? 0 : 1;
      continue;
    }
    total += missPerAgent;
    if (hasNpmPackage(config)) missingDeclaresNpm = true;
  }

  return total + (missingDeclaresNpm ? 1 : 0);
}

let arms: Map<CliArmLabel, CliArm> | null = null;

function buildArms(modules: CliModules): Map<CliArmLabel, CliArm> {
  const root = ensureCliEnv();
  const registry = modules.registry;
  const ids = modules.agentIds;
  const forced = forcedPlantIds(registry);
  const eligible = ids.filter((id) => id !== ALWAYS_ABSENT_AGENT_ID);
  const system = systemPathDirs();

  const duplicateDir = join(root, "duplicate-bin");
  mkdirSync(duplicateDir, { recursive: true });
  plantShim(duplicateDir, registry[DUPLICATE_AGENT_ID]!.command as string);

  const definitions: Array<{
    label: CliArmLabel;
    ids: string[];
    viaPrepend: boolean;
    duplicate: boolean;
  }> = [
    { label: "allMiss", ids: [...forced], viaPrepend: false, duplicate: false },
    {
      label: "half",
      ids: [...new Set([...forced, ...eligible.slice(0, Math.floor(eligible.length / 2))])],
      viaPrepend: false,
      duplicate: false,
    },
    { label: "allHit", ids: [...eligible], viaPrepend: false, duplicate: true },
    { label: "prepend", ids: [...eligible], viaPrepend: true, duplicate: false },
  ];

  const built = new Map<CliArmLabel, CliArm>();
  for (const definition of definitions) {
    const binDir = join(root, `bin-${definition.label}`);
    mkdirSync(binDir, { recursive: true });
    for (const id of definition.ids) {
      plantShim(binDir, registry[id]!.command as string);
    }
    // Everything on PATH is either an empty planting directory of this
    // fixture's own or a system directory holding `which`/`where` itself.
    const pathDirs = definition.viaPrepend
      ? [join(root, `bin-empty-${definition.label}`), ...system]
      : [binDir, ...(definition.duplicate ? [duplicateDir] : []), ...system];
    if (definition.viaPrepend) mkdirSync(pathDirs[0]!, { recursive: true });

    built.set(definition.label, {
      label: definition.label,
      plantedIds: definition.ids,
      path: pathDirs.join(delimiter),
      prepend: definition.viaPrepend ? binDir : null,
      expectedSpawns: expectedSpawnsFor(registry, definition.ids, definition.viaPrepend),
      hasDuplicate: definition.duplicate,
    });
  }
  return built;
}

export function getArm(modules: CliModules, label: CliArmLabel): CliArm {
  arms ??= buildArms(modules);
  const arm = arms.get(label);
  if (arm === undefined) throw new Error(`perf cli fixture: unknown arm "${label}"`);
  return arm;
}

/** Point the stubbed `refreshPath` and the prepend seam at one arm. */
export function activateArm(arm: CliArm): void {
  bridge.path = arm.path;
  process.env.PATH = arm.path;
  if (arm.prepend === null) {
    delete process.env.DAINTREE_CLI_PATH_PREPEND;
  } else {
    process.env.DAINTREE_CLI_PATH_PREPEND = arm.prepend;
  }
}

export function refreshPathCallCount(): number {
  return bridge.refreshCalls;
}

// --- Hermeticity self-check --------------------------------------------------

/**
 * Whether the probed PATH can still produce an honest answer. 0 = hermetic.
 *
 * The found-set oracle only means something if the only copies of an agent CLI
 * reachable from PATH are the ones this fixture planted. Two ways that fails:
 * a system directory on PATH happens to hold an agent binary (a machine with
 * `codex` in `/usr/bin`), or something rewrote `process.env.PATH` out from
 * under the arm. Both are reported rather than silently producing a "found"
 * agent nobody planted — and neither can be discovered from the availability
 * result itself, which is why this is a separate term.
 */
export function pathHermeticityMisses(modules: CliModules, arm: CliArm): number {
  let misses = 0;
  if (process.env.PATH !== arm.path) misses += 1;

  const plantedDirs = new Set(
    arm.path.split(delimiter).filter((dir) => dir.startsWith(fixtureRoot ?? "\u0000"))
  );
  for (const dir of arm.path.split(delimiter)) {
    if (dir === "" || plantedDirs.has(dir)) continue;
    for (const config of Object.values(modules.registry)) {
      const command = config.command;
      if (typeof command !== "string") continue;
      for (const name of shimNamesFor(command)) {
        if (existsSync(join(dir, name))) misses += 1;
      }
    }
  }
  return misses;
}

// --- Grading -----------------------------------------------------------------

/**
 * One accumulator per thing a refresh is supposed to do.
 *
 *   `foundSetMisses`        — symmetric difference between the agents reported
 *                             as anything other than `missing` and the shims
 *                             this fixture planted. Graded in BOTH directions,
 *                             so an availability check that answers "ready" for
 *                             everything scores as heavily as one that answers
 *                             "missing" for everything.
 *   `absentAgentMisses`     — {@link ALWAYS_ABSENT_AGENT_ID} is never planted
 *                             on any arm and must always come back `missing`.
 *                             The term that survives an arm where the planted
 *                             set is empty and the found set trivially matches.
 *   `stateCoverageMisses`   — every registry id appears in the returned map. A
 *                             fan-out that lost entries answers faster.
 *   `spawnCountMisses`      — SIGNED: expected minus observed. Positive means
 *                             the probe ladder did less work than the ladder it
 *                             is supposed to run (the cheap wrong answer);
 *                             negative means it did more. The expectation is
 *                             this fixture's arithmetic over its own planting
 *                             decisions, never a second call into the subject.
 *   `pathRefreshMisses`     — `refresh()` awaited exactly one PATH refresh, and
 *                             `checkAvailability()` on an already-populated
 *                             service awaited none. Counted inside the stub, so
 *                             it also proves which entry point was entered.
 *   `pathHermeticityMisses` — see above.
 */
export interface RefreshGrade {
  foundSetMisses: number;
  absentAgentMisses: number;
  stateCoverageMisses: number;
  spawnCountMisses: number;
  pathRefreshMisses: number;
  pathHermeticityMisses: number;
}

export function emptyRefreshGrade(): RefreshGrade {
  return {
    foundSetMisses: 0,
    absentAgentMisses: 0,
    stateCoverageMisses: 0,
    spawnCountMisses: 0,
    pathRefreshMisses: 0,
    pathHermeticityMisses: 0,
  };
}

export function addRefreshGrade(into: RefreshGrade, from: RefreshGrade): RefreshGrade {
  into.foundSetMisses += from.foundSetMisses;
  into.absentAgentMisses += from.absentAgentMisses;
  into.stateCoverageMisses += from.stateCoverageMisses;
  into.spawnCountMisses += from.spawnCountMisses;
  into.pathRefreshMisses += from.pathRefreshMisses;
  into.pathHermeticityMisses += from.pathHermeticityMisses;
  return into;
}

export function refreshMisses(grade: RefreshGrade): Record<string, number> {
  return {
    foundSetMisses: grade.foundSetMisses,
    absentAgentMisses: grade.absentAgentMisses,
    stateCoverageMisses: grade.stateCoverageMisses,
    spawnCountMisses: grade.spawnCountMisses,
    pathRefreshMisses: grade.pathRefreshMisses,
    pathHermeticityMisses: grade.pathHermeticityMisses,
  };
}

/** Agents reported as anything other than `missing`. */
export function foundAgentIds(availability: CliAvailability): string[] {
  return Object.entries(availability)
    .filter(([, state]) => state !== "missing")
    .map(([id]) => id);
}

export interface RefreshObservation {
  availability: CliAvailability;
  spawns: number;
  refreshPathCalls: number;
  expectedRefreshPathCalls: number;
}

export function gradeRefresh(
  modules: CliModules,
  arm: CliArm,
  observation: RefreshObservation
): RefreshGrade {
  const grade = emptyRefreshGrade();
  const planted = new Set(arm.plantedIds);
  const found = new Set(foundAgentIds(observation.availability));

  for (const id of planted) if (!found.has(id)) grade.foundSetMisses += 1;
  for (const id of found) if (!planted.has(id)) grade.foundSetMisses += 1;

  if (observation.availability[ALWAYS_ABSENT_AGENT_ID] !== "missing") {
    grade.absentAgentMisses += 1;
  }

  for (const id of modules.agentIds) {
    if (observation.availability[id] === undefined) grade.stateCoverageMisses += 1;
  }

  grade.spawnCountMisses += arm.expectedSpawns - observation.spawns;
  grade.pathRefreshMisses += Math.abs(
    observation.expectedRefreshPathCalls - observation.refreshPathCalls
  );
  grade.pathHermeticityMisses += pathHermeticityMisses(modules, arm);

  return grade;
}

// --- Console quieting --------------------------------------------------------

/**
 * Redirect the service's diagnostic `console.log` / `console.warn` to a
 * counting sink for the duration of a measurement.
 *
 * `checkAuth` logs one line per found-but-unauthenticated agent, so an all-hit
 * refresh prints seventeen lines it would print in production too. The count is
 * returned rather than discarded, so the branch is still proven to have run.
 */
export function captureConsole(): () => number {
  const log = console.log;
  const warn = console.warn;
  let count = 0;
  console.log = () => {
    count += 1;
  };
  console.warn = () => {
    count += 1;
  };
  return () => {
    console.log = log;
    console.warn = warn;
    return count;
  };
}
