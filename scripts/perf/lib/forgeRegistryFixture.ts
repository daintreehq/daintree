import nodeModule from "node:module";
import type {
  ForgeProviderContribution,
  ForgeProviderImpl,
  ForgeTokenHealthState,
  RateLimitInfo,
  RegisteredForgeProvider,
  RepoRef,
  ResolvedForgeProvider,
} from "../../../shared/types/forge";
import type { ForgeProviderMatcher } from "../../../shared/utils/forgeHostnames";
import type { ForgeRpcMethod, WorkspaceHostRequest } from "../../../shared/types/workspace-host";
import { serializedBytes } from "./ipcFixture";

/**
 * The REAL main-process forge layer for PERF-340..343, in a plain Node process.
 *
 * CLAUDE.md's forge invariant is that "GitHub ships as a builtin forge plugin so
 * the host stays forge-neutral", which puts every routing decision in five
 * host-side modules that nothing measured: which providers a manifest scan
 * registers, which provider a remote URL resolves to, what the workspace-host's
 * RPC calls cost in messages and bytes, and what the registry's change signal
 * relays. PERF-225 covers forge plugin ACTIVATION and stops there.
 *
 * WHAT IS REAL
 *   - `electron/services/forgeProviderRegistry.ts` — descriptor and impl tables,
 *     the change-listener fan-out, `listForgeProviderMatchers`,
 *     `listMatchingProviders`, `getActiveProvider`. Unmodified product code, and
 *     it imports no Electron binding at all.
 *   - `electron/services/forgeProviderResolver.ts` — the whole
 *     override → global-default → hostname precedence chain, including the
 *     deliberate no-fallthrough on an unregistered override.
 *   - `shared/utils/forgeHostnames.ts` and `shared/utils/forgeProviderIds.ts` —
 *     SCP/HTTPS/SSH hostname extraction, `www.` stripping, the canonical
 *     `{pluginId}.{contributionId}` id and the legacy-alias normalisation.
 *   - `electron/services/forgeRpcServer.ts` — `dispatchForgeRpc`, its
 *     `safe-stable-stringify` singleflight key, the waiter fan-out, the
 *     per-method argument unpacking and the `resolveProvider` special case
 *     including the `not-ready` vs `no-match` distinction and the `projectPath`
 *     stamp.
 *   - `electron/services/forgeHealthRelay.ts` and
 *     `electron/services/forgeMatcherRelay.ts` — the subscribe/dispose diff on
 *     every registry change, the healthy-reset broadcast on removal, and the
 *     matcher-table push.
 *   - `electron/ipc/utils.ts`'s `broadcastToRenderer` and the real
 *     `electron/window/webContentsRegistry.ts`, driven through
 *     `registerAppView` with a stand-in WebContents that records what was sent.
 *     The relay's broadcasts therefore travel the product's own fan-out path.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No Electron.** The bare `electron` specifier is remapped to an inert
 *     stub at the module boundary, the same seam `lib/projectViewFixture.ts`
 *     uses. So `wc.send` is a recorder rather than a renderer IPC hop: message
 *     and byte counts are the product's, the structured-clone cost of a real
 *     Chromium IPC is not.
 *   - **No `PluginService`.** `forgeRpcServer` lazily imports it for implicit
 *     activation, and constructing that singleton hydrates an electron-store and
 *     scans plugin directories — a subsystem PERF-220..225 already measures and
 *     one that would dominate every number here. It is stubbed at the module
 *     boundary with a recorder exposing exactly the two members the RPC server
 *     uses (`activatePluginForForgeProvider`, `isPluginScanComplete`), so the
 *     implicit-activation call is COUNTED but its cost is not measured, and the
 *     `not-ready`/`no-match` branch is driven by flipping the flag.
 *   - **No workspace host.** `WorkspaceClient` is stubbed the same way, so the
 *     matcher-table push and the fetch-throttle relay are recorded at main's
 *     edge. Nothing crosses a process boundary; the relayed payloads are the
 *     real ones the product built.
 *   - **No network, no forge API, no port.** Every provider impl in this file is
 *     a local object; nothing here constructs a URL request or a socket. The
 *     hostnames in the corpus are `.example`/`.invalid` reserved names, so even
 *     a stray resolution attempt could not reach a real host.
 *   - **No real provider.** `plugins/builtin/github` is never loaded. The corpus
 *     mirrors its manifest's shape (and its real `matches` and `capabilities`)
 *     but the impls are fixture-owned, because a real one needs a credential.
 *
 * The product's registries are MODULE-GLOBAL singletons, so every scenario
 * resets them through the product's own `clear*` helpers before each iteration
 * and does that reset outside its timed bracket.
 */

// --- module-boundary stubs ---------------------------------------------------

/**
 * Deliberately wider than the current graph needs: a missing export is a
 * link-time failure rather than a graceful `undefined`, so listing extra names
 * is cheap insurance against a product import added later.
 */
const ELECTRON_STUB_SOURCE = `
const bridge = globalThis.__daintreePerfForgeElectron;
export const app = bridge.app;
export const BrowserWindow = bridge.BrowserWindow;
export const BrowserView = bridge.BrowserView;
export const WebContentsView = bridge.WebContentsView;
export const View = bridge.View;
export const session = bridge.session;
export const webContents = bridge.webContents;
export const ipcMain = bridge.ipcMain;
export const nativeTheme = bridge.nativeTheme;
export const nativeImage = bridge.nativeImage;
export const shell = bridge.shell;
export const dialog = bridge.dialog;
export const screen = bridge.screen;
export const powerMonitor = bridge.powerMonitor;
export const powerSaveBlocker = bridge.powerSaveBlocker;
export const clipboard = bridge.clipboard;
export const Menu = bridge.Menu;
export const MenuItem = bridge.MenuItem;
export const Tray = bridge.Tray;
export const Notification = bridge.Notification;
export const protocol = bridge.protocol;
export const net = bridge.net;
export const utilityProcess = bridge.utilityProcess;
export const MessageChannelMain = bridge.MessageChannelMain;
export const systemPreferences = bridge.systemPreferences;
export const safeStorage = bridge.safeStorage;
export const globalShortcut = bridge.globalShortcut;
export const crashReporter = bridge.crashReporter;
export const contextBridge = bridge.contextBridge;
export const desktopCapturer = bridge.desktopCapturer;
export default bridge;
`;

const PLUGIN_SERVICE_STUB_SOURCE = `
export const pluginService = globalThis.__daintreePerfForgePluginService;
`;

const WORKSPACE_CLIENT_STUB_SOURCE = `
export function getWorkspaceClient() {
  return globalThis.__daintreePerfForgeWorkspaceClient;
}
`;

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** Recorder standing in for the plugin service's implicit-activation call. */
export interface PluginServiceRecorder {
  /** Calls the RPC server made to force the owning plugin's `activate()`. */
  activations: string[];
  /** Drives the RPC server's `not-ready` vs `no-match` branch. */
  scanComplete: boolean;
}

/** Recorder standing in for the workspace-host client at main's edge. */
export interface WorkspaceClientRecorder {
  matcherPushes: ForgeProviderMatcher[][];
  throttleRelays: number[];
}

export const pluginServiceRecorder: PluginServiceRecorder = { activations: [], scanComplete: true };

export const workspaceClientRecorder: WorkspaceClientRecorder = {
  matcherPushes: [],
  throttleRelays: [],
};

const noop = (): undefined => undefined;

const ELECTRON_BRIDGE: Record<string, unknown> = {
  app: {
    getPath: () => "/tmp/daintree-perf-forge",
    getVersion: () => "0.0.0-perf",
    getName: () => "Daintree",
    isPackaged: false,
    on: noop,
    once: noop,
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
    static fromWebContents(): null {
      return null;
    }
  },
  BrowserView: class {},
  WebContentsView: class {},
  View: class {},
  session: {},
  webContents: { getAllWebContents: () => [] },
  ipcMain: { on: noop, handle: noop, removeHandler: noop, removeAllListeners: noop },
  nativeTheme: { on: noop },
  nativeImage: {},
  shell: { openExternal: noop },
  dialog: {},
  screen: {},
  powerMonitor: { on: noop },
  powerSaveBlocker: {},
  clipboard: {},
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({ popup: noop }) },
  MenuItem: class {},
  Tray: class {},
  Notification: class {},
  protocol: {},
  net: {},
  utilityProcess: { fork: noop },
  MessageChannelMain: class {},
  systemPreferences: {},
  safeStorage: { isEncryptionAvailable: () => false },
  globalShortcut: {},
  crashReporter: {},
  contextBridge: {},
  desktopCapturer: {},
};

let hooksInstalled = false;

/**
 * Remap three specifiers so main's forge graph loads outside Electron:
 * `electron` itself, and the two lazily-imported collaborators the forge
 * modules reach for. `PluginService` and `WorkspaceClient` are matched by
 * specifier suffix because that is exactly the literal each product module
 * writes (`"./PluginService.js"`, `"./WorkspaceClient.js"`), and nothing else in
 * the harness imports either.
 *
 * Under Vitest the product graph is resolved by Vite rather than by Node, so a
 * loader hook would never fire; the unit test drives the fixture through the
 * same globals instead of registering one.
 */
function installStubs(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const globals = globalThis as Record<string, unknown>;
  globals.__daintreePerfForgeElectron = ELECTRON_BRIDGE;
  globals.__daintreePerfForgePluginService = {
    activatePluginForForgeProvider: async (namespacedId: string): Promise<void> => {
      pluginServiceRecorder.activations.push(namespacedId);
    },
    get isPluginScanComplete(): boolean {
      return pluginServiceRecorder.scanComplete;
    },
  };
  globals.__daintreePerfForgeWorkspaceClient = {
    relayForgeProviderMatchers: (matchers: ForgeProviderMatcher[]): void => {
      workspaceClientRecorder.matcherPushes.push(matchers);
    },
    relayFetchThrottle: (multiplier: number): void => {
      workspaceClientRecorder.throttleRelays.push(multiplier);
    },
  };

  if (process.env.VITEST) return;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown
        ) => unknown;
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks !== "function") {
    throw new Error(
      "module.registerHooks is unavailable; the forge fixture cannot remap the electron specifier"
    );
  }

  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron") {
        return { url: dataUrl(ELECTRON_STUB_SOURCE), shortCircuit: true };
      }
      if (specifier.endsWith("/PluginService.js")) {
        return { url: dataUrl(PLUGIN_SERVICE_STUB_SOURCE), shortCircuit: true };
      }
      if (specifier.endsWith("/WorkspaceClient.js")) {
        return { url: dataUrl(WORKSPACE_CLIENT_STUB_SOURCE), shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}

// --- product module handles --------------------------------------------------

export interface ForgeRpcRequestLike {
  forgeRequestId: string;
  method: ForgeRpcMethod;
  namespacedId?: string;
  args: unknown[];
}

export interface ForgeModules {
  registerForgeProviders: (pluginId: string, contributions: ForgeProviderContribution[]) => void;
  unregisterForgeProviders: (pluginId: string) => void;
  clearForgeProviderRegistry: () => void;
  registerForgeProviderImpl: (
    pluginId: string,
    contributionId: string,
    impl: ForgeProviderImpl
  ) => void;
  unregisterForgeProviderImpls: (pluginId: string) => void;
  clearForgeProviderImplRegistry: () => void;
  getForgeProviderImpl: (namespacedId: string) => ForgeProviderImpl | undefined;
  hasActivatedForgeProvider: () => boolean;
  getForgeProviderImplEntries: () => Array<[string, ForgeProviderImpl]>;
  getRegisteredForgeProviders: () => RegisteredForgeProvider[];
  listForgeProviderMatchers: () => ForgeProviderMatcher[];
  listMatchingProviders: (remoteUrl: string) => RegisteredForgeProvider[];
  onForgeProviderRegistryChanged: (listener: () => void) => () => void;
  resolveForgeProvider: (inputs: {
    remoteUrl: string | null | undefined;
    forgeProviderOverride: string | null | undefined;
    globalDefaultProviderId: string | null | undefined;
  }) => ResolvedForgeProvider;
  matchProviderForRemoteUrl: (
    remoteUrl: string,
    matchers: readonly ForgeProviderMatcher[]
  ) => string | null;
  makeForgeProviderId: (pluginId: string, contributionId: string) => string;
  dispatchForgeRpc: (
    req: ForgeRpcRequestLike,
    sender: (request: WorkspaceHostRequest) => boolean
  ) => Promise<void>;
  resetForgeRpcInFlight: () => void;
  initForgeHealthRelay: () => void;
  disposeForgeHealthRelay: () => void;
  initForgeMatcherRelay: () => void;
  registerAppView: (win: unknown, view: unknown) => void;
  unregisterAppView: (win: unknown) => void;
  tokenHealthChannel: string;
  rateLimitChannel: string;
}

let modulesPromise: Promise<ForgeModules> | null = null;

export function loadForgeModules(): Promise<ForgeModules> {
  modulesPromise ??= (async () => {
    installStubs();
    const [registry, resolver, rpc, health, matcherRelay, hostnames, ids, channels, wcRegistry] =
      await Promise.all([
        import("../../../electron/services/forgeProviderRegistry"),
        import("../../../electron/services/forgeProviderResolver"),
        import("../../../electron/services/forgeRpcServer"),
        import("../../../electron/services/forgeHealthRelay"),
        import("../../../electron/services/forgeMatcherRelay"),
        import("../../../shared/utils/forgeHostnames"),
        import("../../../shared/utils/forgeProviderIds"),
        import("../../../electron/ipc/channels"),
        import("../../../electron/window/webContentsRegistry"),
      ]);

    return {
      registerForgeProviders: registry.registerForgeProviders,
      unregisterForgeProviders: registry.unregisterForgeProviders,
      clearForgeProviderRegistry: registry.clearForgeProviderRegistry,
      registerForgeProviderImpl: registry.registerForgeProviderImpl,
      unregisterForgeProviderImpls: registry.unregisterForgeProviderImpls,
      clearForgeProviderImplRegistry: registry.clearForgeProviderImplRegistry,
      getForgeProviderImpl: registry.getForgeProviderImpl,
      hasActivatedForgeProvider: registry.hasActivatedForgeProvider,
      getForgeProviderImplEntries: registry.getForgeProviderImplEntries,
      getRegisteredForgeProviders: registry.getRegisteredForgeProviders,
      listForgeProviderMatchers: registry.listForgeProviderMatchers,
      listMatchingProviders: registry.listMatchingProviders,
      onForgeProviderRegistryChanged: registry.onForgeProviderRegistryChanged,
      resolveForgeProvider: resolver.resolveForgeProvider,
      matchProviderForRemoteUrl: hostnames.matchProviderForRemoteUrl,
      makeForgeProviderId: ids.makeForgeProviderId,
      dispatchForgeRpc: rpc.dispatchForgeRpc as ForgeModules["dispatchForgeRpc"],
      resetForgeRpcInFlight: rpc._resetForgeRpcInFlightForTests,
      initForgeHealthRelay: health.initForgeHealthRelay,
      disposeForgeHealthRelay: health.disposeForgeHealthRelay,
      initForgeMatcherRelay: matcherRelay.initForgeMatcherRelay,
      registerAppView: wcRegistry.registerAppView as ForgeModules["registerAppView"],
      unregisterAppView: wcRegistry.unregisterAppView as ForgeModules["unregisterAppView"],
      tokenHealthChannel: channels.CHANNELS.FORGE_TOKEN_HEALTH_CHANGED,
      rateLimitChannel: channels.CHANNELS.FORGE_RATE_LIMIT_CHANGED,
    };
  })();
  return modulesPromise;
}

// --- the declared corpus -----------------------------------------------------

export interface CorpusPlugin {
  pluginId: string;
  contributions: ForgeProviderContribution[];
}

/**
 * The provider roster the scenarios register and grade against.
 *
 * Shaped after `plugins/builtin/github/plugin.json` (its real `matches` and
 * `capabilities`) plus the third-party providers the registry is built to
 * accept. Three entries exist to make routing gradeable rather than to be
 * realistic:
 *
 *   - `contoso.mirror` claims a hostname `acme.gitea` already claims, so
 *     "first registered wins" is an assertion instead of an accident.
 *   - `acme.gitlab` lists a `www.`-prefixed pattern, which normalisation must
 *     collapse onto the bare host.
 *   - `local.files` is a `kind: "local"` provider with no credential fields,
 *     matching a hostname no remote resolves to.
 *
 * Every hostname is under a reserved TLD (`.example`, `.invalid`) or an
 * `example.com` subdomain, so nothing here can name a real forge.
 */
export const FORGE_CORPUS: readonly CorpusPlugin[] = [
  {
    pluginId: "daintree.github",
    contributions: [
      {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        capabilities: [
          "issues",
          "pulls",
          "reviews",
          "required-checks",
          "draft-prs",
          "assignees",
          "releases",
          "batch-branch-prs",
          "identity",
          "clone",
        ],
        slots: {
          settingsTab: "github.forgeSettingsTab",
          icon: "github.providerIcon",
          statsDropdown: "github.statsDropdown",
          bulkCreateWorktreeDialog: "github.bulkCreateWorktreeDialog",
          issueSelector: "github.issueSelector",
        },
      },
    ],
  },
  {
    pluginId: "acme.gitea",
    contributions: [
      {
        id: "gitea",
        name: "Acme Gitea",
        matches: ["gitea.acme.example", "git.acme.example"],
        capabilities: ["issues", "pulls"],
        credentialFields: [{ id: "token", label: "Token", type: "password" }],
      },
    ],
  },
  {
    pluginId: "acme.gitlab",
    contributions: [
      {
        id: "gitlab",
        name: "Acme GitLab",
        matches: ["www.gitlab.acme.example"],
        capabilities: ["issues", "pulls", "draft-prs"],
      },
    ],
  },
  {
    pluginId: "contoso.bitbucket",
    contributions: [
      {
        id: "bitbucket",
        name: "Contoso Bitbucket",
        matches: ["bitbucket.contoso.example"],
        capabilities: ["pulls"],
      },
    ],
  },
  {
    pluginId: "contoso.mirror",
    contributions: [
      {
        id: "mirror",
        name: "Contoso Mirror",
        matches: ["gitea.acme.example"],
        capabilities: ["pulls"],
      },
    ],
  },
  {
    pluginId: "local.files",
    contributions: [
      {
        id: "files",
        name: "Local Files",
        kind: "local",
        matches: ["files.invalid"],
      },
    ],
  },
];

/** How many synthetic providers the scale tier adds on top of {@link FORGE_CORPUS}. */
export const SCALE_PROVIDER_COUNT = 120;

/**
 * A wide roster for the scaling readings. Every hostname is unique and none
 * collides with the corpus, so adding this tier must not change a single
 * expectation in {@link RESOLUTION_CASES} — which is itself checked, because a
 * lookup that got faster by dropping candidates would otherwise read as a win.
 */
export function scaleProviders(count: number = SCALE_PROVIDER_COUNT): CorpusPlugin[] {
  return Array.from({ length: count }, (_, index) => ({
    pluginId: `perf.forge${index}`,
    contributions: [
      {
        id: "provider",
        name: `Perf Forge ${index}`,
        matches: [`forge${index}.perf.invalid`, `alt-forge${index}.perf.invalid`],
      },
    ],
  }));
}

export function canonicalId(plugin: CorpusPlugin, contribution: ForgeProviderContribution): string {
  return `${plugin.pluginId}.${contribution.id}`;
}

/** Every `{pluginId}.{contributionId}` a roster declares, in registration order. */
export function declaredProviderIds(plugins: readonly CorpusPlugin[]): string[] {
  return plugins.flatMap((plugin) =>
    plugin.contributions.map((contribution) => canonicalId(plugin, contribution))
  );
}

/**
 * Hostname patterns per canonical id, as declared — the matcher-table oracle.
 *
 * Takes a roster rather than closing over {@link FORGE_CORPUS}, because the
 * scale tier is registered through the same path and lands in the same table.
 * An oracle covering only the corpus subset would let a builder that omits the
 * 120 scale rows report a faster build with every predicate still at zero.
 */
export function declaredHostnames(
  plugins: readonly CorpusPlugin[]
): Map<string, readonly string[]> {
  return new Map(
    plugins.flatMap((plugin) =>
      plugin.contributions.map(
        (contribution) =>
          [canonicalId(plugin, contribution), [...contribution.matches]] as [string, string[]]
      )
    )
  );
}

export const CORPUS_PROVIDER_IDS: readonly string[] = declaredProviderIds(FORGE_CORPUS);

export const CORPUS_HOSTNAMES: ReadonlyMap<string, readonly string[]> =
  declaredHostnames(FORGE_CORPUS);

export const GITHUB_PROVIDER_ID = "daintree.github.github";
export const GITEA_PROVIDER_ID = "acme.gitea.gitea";
export const GITLAB_PROVIDER_ID = "acme.gitlab.gitlab";
export const BITBUCKET_PROVIDER_ID = "contoso.bitbucket.bitbucket";

// --- the resolution expectation table ---------------------------------------

export interface ResolutionCase {
  name: string;
  remoteUrl: string | null;
  forgeProviderOverride: string | null;
  globalDefaultProviderId: string | null;
  /** Canonical id the resolver must return, or null for "must route nowhere". */
  expectedProviderId: string | null;
  /** Which precedence tier must have decided, or null when nothing resolved. */
  expectedVia: "override" | "default" | "hostname" | null;
  /**
   * What the workspace-host's own matcher table must answer for this remote.
   * Hostname matching only — it knows nothing about overrides or defaults — so
   * this is an INDEPENDENT reading of the same routing question, and the two
   * disagree by design on every override and default row.
   */
  expectedMatcherId: string | null;
}

/**
 * Which query must route to which provider, and which must route to none.
 *
 * Graded in both directions on purpose. A resolver that returns the first
 * registered provider for every query is fast, and it passes every positive
 * hostname row here while failing all eight negative rows plus both
 * precedence tiers. A registry that registers nothing is faster still and
 * fails every positive row. Neither can be told from a healthy resolver by a
 * duration.
 *
 * The negative rows are the ones product behaviour actually turns on:
 * `resolveForgeProvider` deliberately does NOT fall through when an override
 * or a global default names something unavailable, because falling through
 * would silently route a user's repository to a provider they did not choose.
 */
export const RESOLUTION_CASES: readonly ResolutionCase[] = [
  {
    name: "https remote matches the built-in provider",
    remoteUrl: "https://github.com/daintreehq/daintree.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITHUB_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITHUB_PROVIDER_ID,
  },
  {
    name: "scp-form remote resolves the same as https",
    remoteUrl: "git@gitea.acme.example:acme/widgets.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITEA_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITEA_PROVIDER_ID,
  },
  {
    name: "ssh scheme with a port resolves by host, not by the colon",
    remoteUrl: "ssh://git@git.acme.example:2222/acme/widgets.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITEA_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITEA_PROVIDER_ID,
  },
  {
    name: "uppercase host normalises",
    remoteUrl: "https://BITBUCKET.CONTOSO.EXAMPLE/team/repo.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: BITBUCKET_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: BITBUCKET_PROVIDER_ID,
  },
  {
    name: "bare host matches a www-prefixed pattern",
    remoteUrl: "https://gitlab.acme.example/group/repo.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITLAB_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITLAB_PROVIDER_ID,
  },
  {
    name: "www-prefixed remote matches a www-prefixed pattern",
    remoteUrl: "https://www.gitlab.acme.example/group/repo.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITLAB_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITLAB_PROVIDER_ID,
  },
  {
    name: "a contested hostname goes to the first registered claimant",
    remoteUrl: "https://gitea.acme.example/acme/other.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: GITEA_PROVIDER_ID,
    expectedVia: "hostname",
    expectedMatcherId: GITEA_PROVIDER_ID,
  },
  {
    name: "an unclaimed hostname routes nowhere",
    remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: null,
  },
  {
    name: "a malformed remote routes nowhere",
    remoteUrl: "not a url at all",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: null,
  },
  {
    name: "an empty remote routes nowhere",
    remoteUrl: "",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: null,
  },
  {
    name: "a null remote routes nowhere",
    remoteUrl: null,
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: null,
  },
  {
    name: "an override beats a hostname match on another provider",
    remoteUrl: "https://github.com/daintreehq/daintree.git",
    forgeProviderOverride: BITBUCKET_PROVIDER_ID,
    globalDefaultProviderId: null,
    expectedProviderId: BITBUCKET_PROVIDER_ID,
    expectedVia: "override",
    expectedMatcherId: GITHUB_PROVIDER_ID,
  },
  {
    name: "an override resolves even when the remote matches nothing",
    remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
    forgeProviderOverride: GITEA_PROVIDER_ID,
    globalDefaultProviderId: null,
    expectedProviderId: GITEA_PROVIDER_ID,
    expectedVia: "override",
    expectedMatcherId: null,
  },
  {
    name: "an override naming an unregistered provider does NOT fall through",
    remoteUrl: "https://github.com/daintreehq/daintree.git",
    forgeProviderOverride: "nobody.nothing",
    globalDefaultProviderId: null,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: GITHUB_PROVIDER_ID,
  },
  {
    name: "a legacy bare contribution id still resolves as an override",
    remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
    forgeProviderOverride: "bitbucket",
    globalDefaultProviderId: null,
    expectedProviderId: BITBUCKET_PROVIDER_ID,
    expectedVia: "override",
    expectedMatcherId: null,
  },
  {
    name: "a global default that is a candidate for this remote wins the tie",
    remoteUrl: "https://gitea.acme.example/acme/other.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: "contoso.mirror.mirror",
    expectedProviderId: "contoso.mirror.mirror",
    expectedVia: "default",
    expectedMatcherId: GITEA_PROVIDER_ID,
  },
  {
    name: "a global default that is not a candidate does NOT fall through",
    remoteUrl: "https://github.com/daintreehq/daintree.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: BITBUCKET_PROVIDER_ID,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: GITHUB_PROVIDER_ID,
  },
  {
    name: "a global default is ignored when a remote matches nothing",
    remoteUrl: "https://unclaimed.perf.invalid/a/b.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: GITHUB_PROVIDER_ID,
    expectedProviderId: null,
    expectedVia: null,
    expectedMatcherId: null,
  },
  {
    name: "an override outranks a global default",
    remoteUrl: "https://gitea.acme.example/acme/other.git",
    forgeProviderOverride: GITHUB_PROVIDER_ID,
    globalDefaultProviderId: BITBUCKET_PROVIDER_ID,
    expectedProviderId: GITHUB_PROVIDER_ID,
    expectedVia: "override",
    expectedMatcherId: GITEA_PROVIDER_ID,
  },
  {
    name: "a local-kind provider routes like any other",
    remoteUrl: "https://files.invalid/a/b.git",
    forgeProviderOverride: null,
    globalDefaultProviderId: null,
    expectedProviderId: "local.files.files",
    expectedVia: "hostname",
    expectedMatcherId: "local.files.files",
  },
];

// --- fixture provider impls --------------------------------------------------

export interface ImplRecorder {
  /** Every provider method the RPC server actually entered, in order. */
  calls: string[];
  tokenHealthListeners: Array<(state: ForgeTokenHealthState) => void>;
  rateLimitListeners: Array<(info: RateLimitInfo) => void>;
  /** Health subscriptions the relay opened and later disposed. */
  subscribeCount: number;
  disposeCount: number;
}

export function createImplRecorder(): ImplRecorder {
  return {
    calls: [],
    tokenHealthListeners: [],
    rateLimitListeners: [],
    subscribeCount: 0,
    disposeCount: 0,
  };
}

export interface ProviderImplOptions {
  /** Hostname `parseRemote` claims. A URL on another host parses to null. */
  host: string;
  /** Omit the batch surface, so the RPC server's `null` fallbacks are exercised. */
  withBatchLookups?: boolean;
  /** Omit `healthEvents`, so the relay's "provider has no health surface" path runs. */
  withHealthEvents?: boolean;
  /** Omit `onRateLimitChanged`, which is optional on the capability. */
  withRateLimitEvents?: boolean;
}

/**
 * A provider impl covering exactly the surface `forgeRpcServer` and
 * `forgeHealthRelay` call. It is a local object: no network, no credential, no
 * timer. Everything it returns is derived arithmetically from its arguments, so
 * a payload byte count is deterministic across machines.
 */
export function createProviderImpl(
  recorder: ImplRecorder,
  options: ProviderImplOptions
): ForgeProviderImpl {
  const {
    host,
    withBatchLookups = true,
    withHealthEvents = true,
    withRateLimitEvents = true,
  } = options;

  const prFor = (repo: RepoRef, number: number): Record<string, unknown> => ({
    number,
    title: `PR ${number} on ${repo.owner}/${repo.repo}`,
    state: "open",
    url: `https://${host}/${repo.owner}/${repo.repo}/pull/${number}`,
    author: { login: "perf-fixture" },
    branch: `feature/${number}`,
    isDraft: number % 3 === 0,
    rawData: null,
  });

  const impl: Record<string, unknown> = {
    parseRemote(url: string): RepoRef | null {
      recorder.calls.push("parseRemote");
      const match = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(
        url
      );
      if (!match || match[1]?.toLowerCase() !== host) return null;
      return { host, owner: match[2] as string, repo: match[3] as string, rawData: null };
    },
    findPRByBranch(repo: RepoRef, branch: string): Promise<unknown> {
      recorder.calls.push("findPRByBranch");
      return Promise.resolve(prFor(repo, branch.length));
    },
    findPRsByBranches(repo: RepoRef, branches: string[]): Promise<Map<string, unknown>> {
      recorder.calls.push("findPRsByBranches");
      return Promise.resolve(
        new Map(branches.map((branch) => [branch, prFor(repo, branch.length)]))
      );
    },
    getPR(repo: RepoRef, prNumber: number): Promise<unknown> {
      recorder.calls.push("getPR");
      return Promise.resolve(prFor(repo, prNumber));
    },
    getIssue(repo: RepoRef, issueNumber: number): Promise<unknown> {
      recorder.calls.push("getIssue");
      return Promise.resolve({
        number: issueNumber,
        title: `Issue ${issueNumber}`,
        state: "open",
        url: `https://${host}/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
        rawData: null,
      });
    },
    getCIStatus(_repo: RepoRef, prNumber: number): Promise<unknown> {
      recorder.calls.push("getCIStatus");
      return Promise.resolve({ state: prNumber % 2 === 0 ? "success" : "pending", total: 12 });
    },
    getRateLimit(): Promise<RateLimitInfo> {
      recorder.calls.push("getRateLimit");
      return Promise.resolve({
        limit: 5000,
        remaining: 4211,
        resetAt: 1_700_000_000_000,
        throttleMultiplier: 1,
      });
    },
    clearPullRequestCaches(): Promise<void> {
      recorder.calls.push("clearPullRequestCaches");
      return Promise.resolve();
    },
  };

  if (withBatchLookups) {
    impl.batchLookups = {
      findPRsByNumbers(repo: RepoRef, prNumbers: number[]): Promise<Map<number, unknown>> {
        recorder.calls.push("findPRsByNumbers");
        return Promise.resolve(new Map(prNumbers.map((n) => [n, prFor(repo, n)])));
      },
      getCIStatuses(_repo: RepoRef, prNumbers: number[]): Promise<Map<number, unknown>> {
        recorder.calls.push("getCIStatuses");
        return Promise.resolve(
          new Map(prNumbers.map((n) => [n, { state: n % 2 === 0 ? "success" : "failure" }]))
        );
      },
      probeOpenPRList(_repo: RepoRef, tracked: unknown[]): Promise<unknown> {
        recorder.calls.push("probeOpenPRList");
        return Promise.resolve({ openNumbers: tracked.map((_, index) => index + 1), stale: [] });
      },
    };
  }

  if (withHealthEvents) {
    const health: Record<string, unknown> = {
      getTokenHealth: (): ForgeTokenHealthState => ({
        status: "healthy",
        tokenVersion: 1,
        checkedAt: 1_700_000_000_000,
      }),
      onTokenHealthChanged: (callback: (state: ForgeTokenHealthState) => void): (() => void) => {
        recorder.subscribeCount += 1;
        recorder.tokenHealthListeners.push(callback);
        return () => {
          recorder.disposeCount += 1;
          const index = recorder.tokenHealthListeners.indexOf(callback);
          if (index >= 0) recorder.tokenHealthListeners.splice(index, 1);
        };
      },
    };
    if (withRateLimitEvents) {
      health.onRateLimitChanged = (callback: (info: RateLimitInfo) => void): (() => void) => {
        recorder.subscribeCount += 1;
        recorder.rateLimitListeners.push(callback);
        return () => {
          recorder.disposeCount += 1;
          const index = recorder.rateLimitListeners.indexOf(callback);
          if (index >= 0) recorder.rateLimitListeners.splice(index, 1);
        };
      };
    }
    impl.healthEvents = health;
  }

  return impl as unknown as ForgeProviderImpl;
}

// --- recording renderer ------------------------------------------------------

export interface BroadcastRecord {
  channel: string;
  payload: unknown;
}

export interface RendererRecorder {
  sends: BroadcastRecord[];
  bytes: number;
}

let rendererRecorder: RendererRecorder | null = null;
let rendererInstalled = false;

/**
 * Install one stand-in app view into the REAL `webContentsRegistry`, so
 * `broadcastToRenderer` walks the product's own fan-out and lands here.
 * Installed once per process; `resetRendererRecorder()` clears the ledger
 * between iterations.
 */
export async function ensureRecordingRenderer(): Promise<RendererRecorder> {
  const mods = await loadForgeModules();
  if (!rendererRecorder) rendererRecorder = { sends: [], bytes: 0 };
  const recorder = rendererRecorder;
  if (rendererInstalled) return recorder;
  rendererInstalled = true;

  const webContents = {
    id: 4242,
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]): void => {
      const payload = args[0];
      recorder.sends.push({ channel, payload });
      recorder.bytes += serializedBytes([channel, ...args]);
    },
    once: (): void => undefined,
    removeListener: (): void => undefined,
    off: (): void => undefined,
  };
  mods.registerAppView({ id: 1 }, { webContents });
  return recorder;
}

export function resetRendererRecorder(): void {
  if (!rendererRecorder) return;
  rendererRecorder.sends = [];
  rendererRecorder.bytes = 0;
}

// --- shared reset ------------------------------------------------------------

export interface RegistryResetOptions {
  /** Register {@link FORGE_CORPUS} after clearing. */
  withCorpus?: boolean;
  /** Also register {@link scaleProviders}. */
  scale?: number;
}

/**
 * Return the product's module-global registries to a known state.
 *
 * Always called OUTSIDE a timed bracket: it is fixture setup, and the singleton
 * tables would otherwise carry one iteration's providers into the next.
 */
export async function resetForgeRegistry(
  options: RegistryResetOptions = {}
): Promise<ForgeModules> {
  const mods = await loadForgeModules();
  mods.clearForgeProviderImplRegistry();
  mods.clearForgeProviderRegistry();
  mods.resetForgeRpcInFlight();
  pluginServiceRecorder.activations = [];
  pluginServiceRecorder.scanComplete = true;
  workspaceClientRecorder.matcherPushes = [];
  workspaceClientRecorder.throttleRelays = [];
  resetRendererRecorder();

  if (options.withCorpus) {
    for (const plugin of FORGE_CORPUS) {
      mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
    }
  }
  if (options.scale) {
    for (const plugin of scaleProviders(options.scale)) {
      mods.registerForgeProviders(plugin.pluginId, [...plugin.contributions]);
    }
  }
  return mods;
}

/**
 * Let the relays' dynamic `import("./WorkspaceClient.js")` settle.
 *
 * Both relays push asynchronously, so a push triggered by the last registry
 * change of one iteration would otherwise be counted by the next.
 */
export function drainRelayMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
