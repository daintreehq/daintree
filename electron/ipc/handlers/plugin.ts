import { ipcMain, dialog, BrowserWindow, net } from "electron";
import { open, writeFile, rm, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path, { extname, isAbsolute } from "node:path";
import crypto from "node:crypto";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import {
  getPluginActionAuditService,
  type PluginActionAuditService,
} from "../../services/PluginActionAuditService.js";
import {
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
  type PluginActionAuditRecord,
  type PluginAuditConfig,
} from "../../../shared/types/ipc/pluginAudit.js";
import type { PluginDiagnosticsSnapshot } from "../../../shared/types/ipc/pluginDiagnostics.js";
import { PLUGIN_METHOD_CHANNELS } from "./plugin.preload.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import { MAX_DNTR_BYTES } from "../../utils/pluginArchiveConstants.js";
import {
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  acceptedMime,
  dntrSuffixOk,
  fetchWithPrivateHostGuard,
  urlHasCredentials,
} from "../../utils/pluginDownloadPolicy.js";
import { isPrivateOrLoopbackHostname, SCOPED_PLUGIN_NAME_PATTERN } from "../../schemas/plugin.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { stableArgsSha256 } from "../../utils/pluginMcpHash.js";
import { isAuditedHandlerFailure } from "../../utils/pluginAuditMarker.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  getPluginToolbarButtonIds,
  getToolbarButtonConfig,
} from "../../../shared/config/toolbarButtonRegistry.js";
import {
  getPluginPanelKinds,
  type PanelKindConfig,
} from "../../../shared/config/panelKindRegistry.js";
import { isPluginInvokeOwnershipError } from "../../services/plugin/PluginInvokeErrors.js";
import { getPluginMenuItems } from "../../services/pluginMenuRegistry.js";
import { getPluginKeybindings } from "../../services/pluginKeybindingRegistry.js";
import { getPluginContextMenuItems } from "../../services/pluginContextMenuRegistry.js";
import { getPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import type { AgentConfig } from "../../../shared/config/agentRegistry.js";
import {
  getRegisteredForgeProviders,
  type RegisteredForgeProvider,
} from "../../services/forgeProviderRegistry.js";
import { getFileDecorationImpls } from "../../services/fileDecorationRegistry.js";
import type { FileDecoration } from "../../../shared/types/forge.js";
import { isTrustedRendererUrl } from "../../../shared/utils/trustedRenderer.js";
import type {
  LoadedPluginInfo,
  PluginIpcContext,
  PluginActionContribution,
  PluginActionDescriptor,
  PluginInstallOptions,
  PluginInstallError,
  PluginInstallResult,
  PluginCheckUpdateResult,
  PluginSettingsScope,
  PluginSettingsUiValues,
  PluginPickPathRequest,
  PluginWorktreeStatus,
} from "../../../shared/types/plugin.js";
import type { IpcContext } from "../types.js";
import type { ToolbarButtonConfig } from "../../../shared/config/toolbarButtonRegistry.js";
import { assertIpcSecurityReady } from "../ipcGuard.js";

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy accessor (mirrors helpAssistant.ts): PluginService is ~3,200 lines and
// pulls semver/ajv/yauzl — a static import here would re-anchor it on the
// eager startup path that #9285 deferred it off of.
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

async function handleList(): Promise<LoadedPluginInfo[]> {
  // Same init-race guard as `handleToolbarButtons` (#9285): a mount-time pull
  // (pluginRuntimeStore, plugin manager) before the deferred initialize()
  // populates the maps would cache an empty list — wrong `disabled` gating in
  // the renderer until the next provenance broadcast.
  const pluginService = await getPluginService();
  await pluginService.waitForInit();
  return pluginService.listPlugins();
}

async function handleSetEnabled(pluginId: string, enabled: boolean): Promise<void> {
  // A toggle arriving mid-init finds both `plugins` and `disabledPlugins`
  // unpopulated, mis-classifies a built-in as a user plugin, and silently
  // takes the persist-only path — no live load, no provenance broadcast.
  const pluginService = await getPluginService();
  await pluginService.waitForInit();
  await pluginService.setEnabled(pluginId, enabled);
}

// Local-file-header signature that prefixes every ZIP (and therefore every
// `.dntr`) archive. Cheap structural gate before the path reaches #9292's
// atomic install flow.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Trust gate shared by every renderer/CLI entry point that hands a filesystem
 * path to the installer: require a non-empty absolute `.dntr` path whose first
 * four bytes are the ZIP magic. Segment-aware guards only — never a `..`
 * substring match (#4702). Only the header is read (never the whole archive)
 * so a hostile multi-GB file can't be slurped into memory. Returns a
 * structured `{ status: "failed" }` on rejection so callers can surface an
 * inline message without a throw crossing the IPC boundary; returns `null` on
 * success. PluginService.installPlugin keeps its own defense-in-depth stat.
 */
async function validateDntrArchivePath(archivePath: string): Promise<PluginInstallResult | null> {
  const fail = (message: string): PluginInstallResult => ({
    status: "failed",
    errors: [{ code: "archive_invalid", message }],
  });
  if (typeof archivePath !== "string" || archivePath.length === 0) {
    return fail("Couldn't resolve the dropped file's path");
  }
  if (!isAbsolute(archivePath)) {
    return fail("Install path must be an absolute filesystem path");
  }
  if (extname(archivePath).toLowerCase() !== ".dntr") {
    return fail("Only .dntr files can be installed");
  }
  let header: Buffer;
  try {
    const fh = await open(archivePath, "r");
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      header = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return fail("Couldn't read the dropped file");
  }
  if (header.length < 4 || !header.equals(ZIP_MAGIC)) {
    return fail("That file isn't a valid .dntr plugin archive");
  }
  return null;
}

/**
 * Install a plugin from a `.dntr` archive path. Runs the same trust gate as
 * {@link handleInstallFromPath} (absolute + `.dntr` + ZIP-magic header sniff)
 * before touching the installer — both renderer entry points must validate
 * identically (#3769). Structured validation failures come back as
 * `{ status: "failed", errors }` data — never thrown — so the install dialog
 * can render per-field messages intact across the IPC boundary. Only
 * unexpected infrastructure faults (a lock subsystem crash) propagate as a
 * thrown Error.
 */
async function handleInstall(
  archivePath: string,
  opts?: PluginInstallOptions
): Promise<PluginInstallResult> {
  const invalid = await validateDntrArchivePath(archivePath);
  if (invalid) return invalid;
  return (await getPluginService()).installPlugin(archivePath, opts);
}

// Install-from-file owns the native-picker entry point; the selected path runs
// the SAME trust gate + installer as the drag-and-drop path
// ({@link handleInstallFromPath}) so both renderer entries validate identically.
// A dismissed picker resolves `cancelled`; validation failures come back as
// structured `{ status: "failed" }` data the dialog can render inline.
async function handleInstallFromFile(ctx: IpcContext): Promise<PluginInstallResult> {
  const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
  const dialogOptions = {
    title: "Install plugin",
    filters: [{ name: "Daintree plugins", extensions: ["dntr"] }],
    properties: ["openFile" as const],
  };
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) {
    return { status: "cancelled" };
  }
  return handleInstallFromPath(result.filePaths[0]!);
}

// Bounded download limits for install-from-URL (F24). Mirrors the spec in
// docs/plugins/distribution.md: a 30 MB hard cap aborted mid-stream, a shared
// deadline, and a MIME/suffix allowlist so a stray HTML error page never
// reaches the installer. The timeout and MIME/suffix policy are shared with the
// update-check path via electron/utils/pluginDownloadPolicy.ts so a server that
// passes one path's gate passes the other's too.

function isAbortLikeError(err: unknown): boolean {
  // AbortSignal.timeout() rejects as "AbortError" (not "TimeoutError") under
  // Chromium 146, and the size-cap controller.abort() also surfaces as
  // "AbortError" — so both names are treated as abort-like and disambiguated
  // by the caller's `sizeAborted` flag. These rejections are DOMExceptions,
  // which are NOT `Error` instances in Node, so duck-type the `name`.
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Install a plugin from a path produced by a drag-and-drop onto the Plugin
 * settings tab (#9295). The renderer resolves the native path via the
 * plugin-scoped `getDroppedFilePath` bridge and hands it here; main owns every
 * trust gate via {@link validateDntrArchivePath} because the renderer can't be
 * trusted to validate before #9292 runs. All failures come back as structured
 * `{ status: "failed" }` data (never thrown) so the tab can render an inline
 * message.
 */
export async function handleInstallFromPath(path: string): Promise<PluginInstallResult> {
  const invalid = await validateDntrArchivePath(path);
  if (invalid) return invalid;
  return (await getPluginService()).installPlugin(path);
}

/**
 * Download a `.dntr` archive from a user-supplied URL into a temp file under
 * bounded conditions, then hand the path to the atomic installer (F24).
 *
 * Guards, in order: well-formed URL + http/https scheme + no embedded
 * credentials, a private/loopback-host check revalidated on every redirect hop,
 * the shared download deadline, a MIME/`.dntr`-suffix allowlist, and a
 * mid-stream 30 MB byte cap that aborts the in-flight request. (Timeout and
 * MIME/suffix policy live in electron/utils/pluginDownloadPolicy.ts.) All
 * failures resolve as
 * structured `{ status: "failed", errors }` data so the dialog can render a
 * tailored message; the handler-owned temp file is always removed in `finally`
 * (PluginService extracts into its own temp dir and doesn't take ownership of
 * the download artifact).
 */
export async function handleInstallFromUrl(url: string): Promise<PluginInstallResult> {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { status: "invalid-url" };
  }
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { status: "invalid-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { status: "invalid-url" };
  }
  if (isPrivateOrLoopbackHostname(parsed.hostname)) {
    return { status: "invalid-url" };
  }
  // Reject `https://user:pass@host` outright — the credentials would otherwise
  // be fetched AND persisted as installer `originalUrl` provenance (re-fetched
  // on update-check, shown in Settings). Rejecting keeps the failure visible.
  if (urlHasCredentials(parsed)) {
    return { status: "invalid-url" };
  }

  const failed = (code: PluginInstallError["code"], message: string): PluginInstallResult => ({
    status: "failed",
    errors: [{ code, message }],
  });

  const tempPath = path.join(os.tmpdir(), `daintree-plugin-${crypto.randomUUID()}.dntr`);
  // Redirects are followed MANUALLY so every hop's host is revalidated through
  // the private/loopback guard — the original-host check alone is bypassable by
  // a public URL that 30x-redirects to loopback/link-local/RFC1918 (SSRF). The
  // size controller and the timeout signal both feed a single AbortSignal.any()
  // that's threaded through every hop.
  const sizeController = new AbortController();
  let sizeAborted = false;
  let wroteTempFile = false;

  try {
    const signal = AbortSignal.any([
      sizeController.signal,
      AbortSignal.timeout(PLUGIN_DOWNLOAD_TIMEOUT_MS),
    ]);

    let response: Response;
    try {
      const guarded = await fetchWithPrivateHostGuard(net.fetch, trimmed, { signal });
      if (!guarded.ok) {
        return failed(
          "fetch_failed",
          guarded.reason === "private-redirect" || guarded.reason === "private-host"
            ? "The download resolved to a private or loopback address."
            : guarded.reason === "insecure-protocol"
              ? "The download redirected to an insecure (non-https) URL."
              : "The download followed too many redirects."
        );
      }
      response = guarded.response;
    } catch (err) {
      if (isAbortLikeError(err)) {
        return failed("fetch_timeout", "The download timed out before it finished.");
      }
      return failed("fetch_failed", "Couldn't download the plugin from that URL.");
    }

    // Drop the open connection on any early return so the socket isn't held
    // until GC; the body is never consumed on these paths.
    const abandon = async (result: PluginInstallResult): Promise<PluginInstallResult> => {
      await response.body?.cancel().catch(() => {});
      return result;
    };

    if (!response.ok) {
      return abandon(failed("fetch_failed", `The server returned HTTP ${response.status}.`));
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > MAX_DNTR_BYTES) {
        return abandon(failed("size_exceeded", "The plugin file is larger than the 30 MB limit."));
      }
    }

    // Accept any of the shared archive MIME types, or fall back to a 2xx whose
    // URL path ends in `.dntr` (case-insensitive for pasted URLs). response.url
    // is unreliable in Electron, so the `.dntr` suffix is checked on the
    // original user URL. Policy is shared with the update-check path.
    const contentType = response.headers.get("content-type") ?? "";
    const mimeOk = acceptedMime(contentType);
    const suffixOk = dntrSuffixOk(parsed.pathname);
    if (!mimeOk && !suffixOk) {
      return abandon(
        failed("content_type_rejected", "That URL didn't return a plugin archive (.dntr).")
      );
    }

    if (!response.body) {
      return failed("fetch_failed", "The server returned an empty response.");
    }

    let bytesRead = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesRead += chunk.length;
        if (bytesRead > MAX_DNTR_BYTES) {
          sizeAborted = true;
          sizeController.abort();
          cb(new Error("size_exceeded"));
          return;
        }
        cb(null, chunk);
      },
    });

    wroteTempFile = true;
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        createWriteStream(tempPath)
      );
    } catch (err) {
      if (sizeAborted) {
        return failed("size_exceeded", "The plugin file is larger than the 30 MB limit.");
      }
      if (isAbortLikeError(err)) {
        return failed("fetch_timeout", "The download timed out before it finished.");
      }
      return failed("fetch_failed", "Couldn't download the plugin from that URL.");
    }

    return (await getPluginService()).installPlugin(tempPath, {
      source: "url",
      originalUrl: trimmed,
    });
  } finally {
    if (wroteTempFile) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

export async function handleUninstall(pluginId: string, deleteSettings?: boolean): Promise<void> {
  if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
    throw new Error("uninstall: pluginId must be a non-empty string");
  }
  // Validate against the scoped-name format before the service touches the
  // filesystem — uninstall feeds pluginId straight into `fs.rm(<root>/<id>)`,
  // so a compromised renderer passing `"../.."` must be rejected at the trust
  // boundary, not just defended in depth in the service.
  if (!SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("uninstall: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (deleteSettings !== undefined && typeof deleteSettings !== "boolean") {
    throw new Error("uninstall: deleteSettings must be a boolean");
  }
  await (await getPluginService()).uninstallPlugin(pluginId, deleteSettings);
}

async function handleCheckForUpdate(pluginId: string): Promise<PluginCheckUpdateResult> {
  if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
    return { status: "invalid-id" };
  }
  // The service owns the bounded download + hash compare and returns a
  // structured result for every domain outcome (#9297).
  return (await getPluginService()).checkForUpdate(pluginId);
}

async function handleToolbarButtons(): Promise<ToolbarButtonConfig[]> {
  // Block the renderer's mount-time pull until startup activation has settled,
  // otherwise a fast renderer can read an empty registry before any plugin's
  // activate() runs — leaving plugin toolbar buttons missing until the next
  // mutation pushes a fresh broadcast (#9285).
  await (await getPluginService()).waitForInit();
  return getPluginToolbarButtonIds()
    .map((id) => getToolbarButtonConfig(id))
    .filter((c): c is ToolbarButtonConfig => c !== undefined);
}

async function handleKeybindings() {
  await (await getPluginService()).waitForInit();
  return getPluginKeybindings();
}

async function handleContextMenuItems() {
  // Same init-race guard as `handleToolbarButtons` — block until startup
  // activation settles so the renderer's mount-time pull can't observe an empty
  // registry before plugins finish registering (#9285).
  await (await getPluginService()).waitForInit();
  return getPluginContextMenuItems();
}

async function handleValidateActionIds(actionIds: string[]): Promise<void> {
  if (!Array.isArray(actionIds)) return;

  const knownIds = new Set(actionIds.filter((id): id is string => typeof id === "string"));

  // Plugin-contributed actions are registered dynamically in the renderer
  // after this snapshot runs, so their IDs won't appear in `knownIds`. Pull
  // the live plugin-action registry from the main-side PluginService and
  // treat those as known.
  for (const { id } of (await getPluginService()).listPluginActions()) {
    knownIds.add(id);
  }

  for (const id of getPluginToolbarButtonIds()) {
    const config = getToolbarButtonConfig(id);
    if (!config) continue;
    if (!knownIds.has(config.actionId)) {
      console.warn(
        `[Plugin] Unknown actionId "${config.actionId}" on toolbar button "${config.id}" (plugin: ${config.pluginId})`
      );
    }
  }

  for (const { pluginId, item } of getPluginMenuItems()) {
    if (!knownIds.has(item.actionId)) {
      console.warn(
        `[Plugin] Unknown actionId "${item.actionId}" on menu item "${item.label}" (plugin: ${pluginId})`
      );
    }
  }
}

// Trust model for plugin:actions-* channels: defineIpcNamespace deliberately
// omits an isTrustedRendererUrl check because contextBridge only exposes
// window.electron to trusted renderer frames (the app origin). Untrusted
// iframes, <webview>, and portal WebContents have no access to this API,
// so no per-request URL check is needed. PLUGIN_INVOKE has a check only
// because it uses raw ipcMain.handle for its variadic signature, which
// gives it direct access to event.senderFrame — the typed path here does
// not and doesn't need it.
async function handleActionsGet(): Promise<PluginActionDescriptor[]> {
  const pluginService = await getPluginService();
  await pluginService.waitForInit();
  return pluginService.listPluginActions();
}

async function handleActionsRegister(
  pluginId: string,
  contribution: PluginActionContribution
): Promise<void> {
  (await getPluginService()).registerPluginAction(pluginId, contribution);
}

async function handleActionsUnregister(pluginId: string, actionId: string): Promise<void> {
  (await getPluginService()).unregisterPluginAction(pluginId, actionId);
}

async function handlePanelKindsGet(): Promise<PanelKindConfig[]> {
  await (await getPluginService()).waitForInit();
  return getPluginPanelKinds();
}

/**
 * Implicit activation for contributed panel views (#10523): force the plugin
 * owning `panelKindId` to `activate()` before the renderer imports its
 * `plugin://` module, so handlers bound during `activate()` are live when the
 * view first renders. `activatePlugin` never rejects, so this resolves even
 * when activation fails — the failure surfaces as a `loadError` and the view's
 * module import then fails through the host's ErrorBoundary retry path. A no-op
 * once the owning plugin is already activated, or when the kind id is unknown.
 */
async function handleActivateForView(panelKindId: string): Promise<void> {
  await (await getPluginService()).activatePluginForView(panelKindId);
}

async function handleForgeProvidersGet(): Promise<RegisteredForgeProvider[]> {
  // Same init-race guard as the surrounding pull-on-mount handlers (#9285) —
  // forge descriptors register during the deferred initialize().
  await (await getPluginService()).waitForInit();
  return getRegisteredForgeProviders();
}

async function handleAgentsGet(): Promise<Record<string, AgentConfig>> {
  await (await getPluginService()).waitForInit();
  return getPluginAgentRegistry();
}

/**
 * Per-provider budget for a single `provideDecorations` call. A provider that
 * never settles its promise would otherwise hang the whole IPC invocation
 * (and the renderer's pull) indefinitely — `Promise.allSettled` only handles
 * rejection, not a promise that simply never resolves. On expiry the slow
 * provider is treated like a rejecting one (skipped + logged); healthy
 * providers for the same scope are unaffected.
 */
const DECORATION_PROVIDER_TIMEOUT_MS = 3000;

const DECORATION_TIMEOUT = Symbol("decoration-timeout");

/**
 * Append an audit record without ever surfacing an audit failure to the
 * caller. Mirrors `forgeAuditService.safeAppend` — a throw from `append()`
 * (corrupt store, disk error) must never swallow the handler's return value
 * or replace the original error. Audit is strictly a side channel; the
 * `#8442` doctrine is that the record is best-effort, not load-bearing.
 */
function safeAppend(input: Parameters<PluginActionAuditService["append"]>[0]): void {
  try {
    getPluginActionAuditService().append(input);
  } catch (err) {
    console.error("[PluginAudit] Failed to append audit record:", err);
  }
}

/**
 * Cap on attacker-controlled URL strings before they're embedded into an
 * audit `errorMessage`. The origin and path prefix are forensically useful;
 * the rest is log pollution and a vector for stuffing secret-like values
 * into the persistent ring buffer.
 */
const UNTRUSTED_URL_MAX_CHARS = 200;

/**
 * A non-empty string is "present" for merge purposes. Empty string counts as
 * absent so it can't block a later provider from supplying a real value.
 */
function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve per-file decorations for `scope` over the given `paths` by invoking
 * every plugin impl whose declared scopes match. Results merge with
 * first-writer-wins semantics per field (badge/tooltip/color independently):
 * the first provider in plugin load order that returns a non-empty value for a
 * field on a path keeps it. The host treats every decoration opaquely — it
 * never inspects what a badge means. A provider that throws, rejects, or
 * exceeds {@link DECORATION_PROVIDER_TIMEOUT_MS} is skipped (logged) so one
 * bad plugin can't blank or stall the whole row. Only the requested paths are
 * returned — a provider that decorates unrequested paths can't leak them.
 */
async function handleFileDecorationsGet(
  scope: string,
  paths: string[]
): Promise<Record<string, FileDecoration>> {
  if (typeof scope !== "string" || scope.length === 0) return {};
  if (!Array.isArray(paths) || paths.length === 0) return {};
  const cleanPaths = [
    ...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0)),
  ];
  if (cleanPaths.length === 0) return {};
  const requested = new Set(cleanPaths);

  // Implicit activation: any plugin that declares a provider for this scope is
  // forced to `activate()` before the impl lookup, so providers bound during
  // activate() are queryable on the first pull. No-op once already activated.
  await (await getPluginService()).activatePluginsForFileDecorationScope(scope);

  const impls = getFileDecorationImpls(scope);
  if (impls.length === 0) return {};

  const merged: Record<string, FileDecoration> = {};
  // Per-provider start/end timestamps so audit records carry the true elapsed
  // time of *each* provider, not the wall-clock of the slowest one. `ends[i]`
  // is captured inside the race chain at the moment that provider settles,
  // before `Promise.allSettled` returns — measuring `Date.now()` in the
  // post-allSettled loop would assign every provider the same wall-clock.
  const starts: number[] = new Array(impls.length);
  const ends: number[] = new Array(impls.length);
  const results = await Promise.allSettled(
    impls.map(({ impl }, i) => {
      starts[i] = Date.now();
      return Promise.race([
        impl.provideDecorations(scope, cleanPaths),
        new Promise<typeof DECORATION_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(DECORATION_TIMEOUT), DECORATION_PROVIDER_TIMEOUT_MS)
        ),
      ]).then(
        (v) => {
          ends[i] = Date.now();
          return v;
        },
        (err: unknown) => {
          ends[i] = Date.now();
          throw err;
        }
      );
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { pluginId, contributionId } = impls[i];
    const durationMs = ends[i] - starts[i];
    if (r.status === "rejected") {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" failed for scope "${scope}":`,
        r.reason
      );
      safeAppend({
        pluginId,
        actionId: contributionId,
        recordType: "decoration-failure",
        result: "error",
        failureMode: "rejected",
        scope,
        contributionId,
        errorMessage: formatErrorMessage(r.reason, "decoration provider rejected"),
        argsHash: "",
        durationMs,
      });
      continue;
    }
    if (r.value === DECORATION_TIMEOUT) {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" timed out after ${DECORATION_PROVIDER_TIMEOUT_MS}ms for scope "${scope}"`
      );
      safeAppend({
        pluginId,
        actionId: contributionId,
        recordType: "decoration-failure",
        result: "error",
        failureMode: "timeout",
        scope,
        contributionId,
        errorMessage: `timed out after ${DECORATION_PROVIDER_TIMEOUT_MS}ms`,
        argsHash: "",
        durationMs,
      });
      continue;
    }
    if (!r.value || typeof r.value !== "object") continue;
    for (const [path, decoration] of Object.entries(r.value)) {
      // Enforce the requested-paths contract at the host boundary so a
      // misbehaving provider can't widen the result set.
      if (!requested.has(path)) continue;
      if (!decoration || typeof decoration !== "object") continue;
      const target = merged[path] ?? (merged[path] = {});
      if (target.badge === undefined) {
        const badge = presentString(decoration.badge);
        if (badge !== undefined) target.badge = badge;
      }
      if (target.tooltip === undefined) {
        const tooltip = presentString(decoration.tooltip);
        if (tooltip !== undefined) target.tooltip = tooltip;
      }
      if (target.color === undefined) {
        const color = presentString(decoration.color);
        if (color !== undefined) target.color = color;
      }
      if (target.url === undefined) {
        // Issue #9953: the renderer uses `decoration.url` as the click
        // target for the review-thread badge. The IPC boundary must
        // forward the provider-authored URL — anything string-shaped is
        // accepted here; `systemClient.openExternal` (lesson #9316)
        // applies the protocol allowlist downstream so a malicious
        // provider can't reach `file://`/`javascript:`.
        const url = presentString(decoration.url);
        if (url !== undefined) target.url = url;
      }
    }
  }

  // Drop paths that ended up with no fields (a provider returned an entry but
  // every field was empty) so the renderer's "decorated?" check stays cheap.
  // `url` participates: a URL-only decoration (a future provider ships
  // just a deep-link without badge/tooltip/color) must still survive the
  // cleanup so the renderer's click target is wired.
  for (const [path, decoration] of Object.entries(merged)) {
    if (
      decoration.badge === undefined &&
      decoration.tooltip === undefined &&
      decoration.color === undefined &&
      decoration.url === undefined
    ) {
      delete merged[path];
    }
  }

  return merged;
}

/**
 * Renderer-facing read of the changed-file / git-status projection for the
 * worktree at `path` — the companion to the per-plugin `host.getWorktreeStatus`
 * so a file list outside the Review Hub can scan the changed set. Reads the
 * host's already-polled status; never shells out. `null` when no worktree
 * matches or no status has been computed.
 */
async function handleWorktreeStatusGet(path: string): Promise<PluginWorktreeStatus | null> {
  if (typeof path !== "string" || path.length === 0) return null;
  return (await getPluginService()).getWorktreeStatusForPath(path);
}

// ── Plugin-action audit log ───────────────────────────────────────────────

async function handleGetAuditRecords(): Promise<PluginActionAuditRecord[]> {
  return getPluginActionAuditService().getRecords();
}

async function handleGetAuditConfig(): Promise<PluginAuditConfig> {
  return getPluginActionAuditService().getConfig();
}

/**
 * Wipe every plugin's audit records. Unlike the read-only audit getters, this
 * destroys the shared forensic trail, so it carries a sender-trust gate that
 * the read paths don't need (#10517). Plugin view modules are `import()`ed
 * into the shared renderer realm, but a frame outside the first-party origin
 * (a cross-origin iframe, `<webview>`, or portal WebContents) must never reach
 * this — it would let an untrusted surface erase the evidence of its own and
 * every other plugin's activity. The rejected attempt is itself audited (the
 * security-relevant signal is "an untrusted frame tried to clear the log"),
 * mirroring the `plugin:invoke` trust check.
 */
async function handleClearAuditLog(ctx: IpcContext): Promise<void> {
  const senderUrl = ctx.event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
    const safeUrl = senderUrl
      ? scrubSecrets(senderUrl.slice(0, UNTRUSTED_URL_MAX_CHARS))
      : "unknown";
    safeAppend({
      pluginId: "",
      actionId: PLUGIN_METHOD_CHANNELS.clearAuditLog,
      recordType: "ipc-invoke",
      channel: PLUGIN_METHOD_CHANNELS.clearAuditLog,
      result: "restricted",
      errorMessage: `untrusted sender (url=${safeUrl})`,
      argsHash: "",
      durationMs: 0,
    });
    throw new Error(`plugin:clear-audit-log rejected: untrusted sender (url=${safeUrl})`);
  }
  getPluginActionAuditService().clear();
}

async function handleSetAuditEnabled(enabled: boolean): Promise<PluginAuditConfig> {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  return getPluginActionAuditService().setEnabled(enabled);
}

async function handleSetAuditMaxRecords(max: number): Promise<PluginAuditConfig> {
  if (typeof max !== "number" || !Number.isFinite(max) || !Number.isInteger(max)) {
    throw new Error("max must be a finite integer");
  }
  if (max < PLUGIN_AUDIT_MIN_RECORDS || max > PLUGIN_AUDIT_MAX_RECORDS) {
    throw new Error(
      `max must be between ${PLUGIN_AUDIT_MIN_RECORDS} and ${PLUGIN_AUDIT_MAX_RECORDS}`
    );
  }
  return getPluginActionAuditService().setMaxRecords(max);
}

async function handleExportAuditLog(records: PluginActionAuditRecord[]): Promise<boolean> {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  const ndjsonContent = getPluginActionAuditService().exportRecords(records) + "\n";
  const now = Date.now();
  const defaultFilename = `plugin-audit-log-${new Date(now).toISOString().replace(/[:.]/g, "-")}.ndjson`;
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Export plugin audit log",
    defaultPath: defaultFilename,
    filters: [{ name: "NDJSON Files", extensions: ["ndjson"] }],
  });
  if (canceled || !filePath) return false;
  await writeFile(filePath, ndjsonContent, "utf-8");
  return true;
}

// ── Plugin diagnostics snapshot ───────────────────────────────────────────

async function handleGetDiagnosticsSnapshot(): Promise<PluginDiagnosticsSnapshot> {
  // Block until startup activation settles so the snapshot is post-activation
  // (mirrors handleToolbarButtons) — otherwise a fast renderer could read an
  // empty plugin set before any activate() runs.
  const pluginService = await getPluginService();
  await pluginService.waitForInit();
  return pluginService.getDiagnosticsSnapshot();
}

// ── Plugin settings UI bridge (#9301) ─────────────────────────────────────

async function handleSettingsGetValues(
  pluginId: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<PluginSettingsUiValues> {
  return (await getPluginService()).getSettingValuesForUi(pluginId, scope, projectId);
}

async function handleSettingsSetValue(
  pluginId: string,
  key: string,
  value: unknown,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<void> {
  await (await getPluginService()).setSettingValueFromUi(pluginId, key, value, scope, projectId);
}

async function handleSettingsDeleteValue(
  pluginId: string,
  key: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<void> {
  await (await getPluginService()).deleteSettingValueFromUi(pluginId, key, scope, projectId);
}

async function handleSettingsRevealSecret(
  pluginId: string,
  key: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<string | null> {
  return (await getPluginService()).revealSecretSettingForUi(pluginId, key, scope, projectId);
}

// Native folder/file chooser for `path` / `directory` / `file` settings fields.
// User-initiated from the settings form's "Browse" button, so it carries no
// capability gate — but `pluginId` must be a well-formed scoped name so the
// surface stays bounded to an actual plugin (mirrors handleUninstall's guard).
// Reuses the install flow's showOpenDialog pattern. Returns the chosen absolute
// path, or null when the picker is dismissed.
async function handlePickPath(
  ctx: IpcContext,
  pluginId: string,
  request: PluginPickPathRequest
): Promise<string | null> {
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("pickPath: pluginId must be a scoped plugin name (publisher.name)");
  }
  const isDirectory = request.kind === "directory";
  const properties: Array<"openFile" | "openDirectory"> = isDirectory
    ? ["openDirectory"]
    : ["openFile"];
  const filters =
    !isDirectory && request.filters && request.filters.length > 0
      ? request.filters.map((f) => ({ name: f.name, extensions: f.extensions }))
      : undefined;
  const defaultPath =
    typeof request.defaultPath === "string" && isAbsolute(request.defaultPath)
      ? request.defaultPath
      : undefined;
  const dialogOptions = {
    title: isDirectory ? "Choose folder" : "Choose file",
    properties,
    ...(filters ? { filters } : {}),
    ...(defaultPath ? { defaultPath } : {}),
  };
  const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0]!;
}

// Existence probe for `mustExist` path/directory/file settings. The settings form
// flags a stored path that no longer resolves on disk (it may have been moved or
// deleted since it was picked). Scoped to a valid pluginId; a non-absolute path
// resolves false rather than throwing so a stale stored value can't crash the
// form.
async function handlePathExists(pluginId: string, targetPath: string): Promise<boolean> {
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("pathExists: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
    return false;
  }
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export const pluginNamespace = defineIpcNamespace({
  name: "plugin",
  ops: {
    list: op(PLUGIN_METHOD_CHANNELS.list, handleList),
    install: op(PLUGIN_METHOD_CHANNELS.install, handleInstall),
    setEnabled: op(PLUGIN_METHOD_CHANNELS.setEnabled, handleSetEnabled),
    installFromFile: op(PLUGIN_METHOD_CHANNELS.installFromFile, handleInstallFromFile, {
      withContext: true,
    }),
    installFromPath: op(PLUGIN_METHOD_CHANNELS.installFromPath, handleInstallFromPath),
    installFromUrl: op(PLUGIN_METHOD_CHANNELS.installFromUrl, handleInstallFromUrl),
    uninstall: op(PLUGIN_METHOD_CHANNELS.uninstall, handleUninstall),
    checkForUpdate: op(PLUGIN_METHOD_CHANNELS.checkForUpdate, handleCheckForUpdate),
    toolbarButtons: op(PLUGIN_METHOD_CHANNELS.toolbarButtons, handleToolbarButtons),
    keybindings: op(PLUGIN_METHOD_CHANNELS.keybindings, handleKeybindings),
    contextMenuItems: op(PLUGIN_METHOD_CHANNELS.contextMenuItems, handleContextMenuItems),
    validateActionIds: op(PLUGIN_METHOD_CHANNELS.validateActionIds, handleValidateActionIds),
    getActions: op(PLUGIN_METHOD_CHANNELS.getActions, handleActionsGet),
    registerAction: op(PLUGIN_METHOD_CHANNELS.registerAction, handleActionsRegister),
    unregisterAction: op(PLUGIN_METHOD_CHANNELS.unregisterAction, handleActionsUnregister),
    getPanelKinds: op(PLUGIN_METHOD_CHANNELS.getPanelKinds, handlePanelKindsGet),
    activateForView: op(PLUGIN_METHOD_CHANNELS.activateForView, handleActivateForView),
    getAgents: op(PLUGIN_METHOD_CHANNELS.getAgents, handleAgentsGet),
    getForgeProviders: op(PLUGIN_METHOD_CHANNELS.getForgeProviders, handleForgeProvidersGet),
    getDecorations: op(PLUGIN_METHOD_CHANNELS.getDecorations, handleFileDecorationsGet),
    getWorktreeStatus: op(PLUGIN_METHOD_CHANNELS.getWorktreeStatus, handleWorktreeStatusGet),
    getAuditRecords: op(PLUGIN_METHOD_CHANNELS.getAuditRecords, handleGetAuditRecords),
    getAuditConfig: op(PLUGIN_METHOD_CHANNELS.getAuditConfig, handleGetAuditConfig),
    clearAuditLog: op(PLUGIN_METHOD_CHANNELS.clearAuditLog, handleClearAuditLog, {
      withContext: true,
    }),
    setAuditEnabled: op(PLUGIN_METHOD_CHANNELS.setAuditEnabled, handleSetAuditEnabled),
    setAuditMaxRecords: op(PLUGIN_METHOD_CHANNELS.setAuditMaxRecords, handleSetAuditMaxRecords),
    exportAuditLog: op(PLUGIN_METHOD_CHANNELS.exportAuditLog, handleExportAuditLog),
    getDiagnosticsSnapshot: op(
      PLUGIN_METHOD_CHANNELS.getDiagnosticsSnapshot,
      handleGetDiagnosticsSnapshot
    ),
    getSettingValues: op(PLUGIN_METHOD_CHANNELS.getSettingValues, handleSettingsGetValues),
    setSettingValue: op(PLUGIN_METHOD_CHANNELS.setSettingValue, handleSettingsSetValue),
    deleteSettingValue: op(PLUGIN_METHOD_CHANNELS.deleteSettingValue, handleSettingsDeleteValue),
    revealSecretSetting: op(PLUGIN_METHOD_CHANNELS.revealSecretSetting, handleSettingsRevealSecret),
    pickPath: op(PLUGIN_METHOD_CHANNELS.pickPath, handlePickPath, { withContext: true }),
    pathExists: op(PLUGIN_METHOD_CHANNELS.pathExists, handlePathExists),
  },
});

export function registerPluginHandlers(): () => void {
  const cleanups: Array<() => void> = [pluginNamespace.register()];

  // plugin:invoke intentionally stays on raw ipcMain.handle: its variadic
  // `...args: unknown[]` signature and senderFrame.url trust check can't be
  // expressed through IpcInvokeMap without widening types to `unknown[]`,
  // which would silently defeat the compile-time safety the migration is for.
  assertIpcSecurityReady(CHANNELS.PLUGIN_INVOKE);
  ipcMain.handle(
    CHANNELS.PLUGIN_INVOKE,
    async (event, pluginId: string, channel: string, ...args: unknown[]) => {
      const start = Date.now();
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        // Trust check rejected — args are attacker-controlled and unvalidated,
        // so we record the rejection without hashing the payload (#8442:
        // audit-even-when-silenced; the security-relevant signal is "an
        // untrusted frame attempted to invoke this plugin"). Cap the URL
        // before it lands in the persistent log so a hostile frame can't
        // stuff arbitrary content into the audit by sending a giant URL.
        const safeUrl = senderUrl
          ? scrubSecrets(senderUrl.slice(0, UNTRUSTED_URL_MAX_CHARS))
          : "unknown";
        safeAppend({
          pluginId,
          actionId: channel,
          recordType: "ipc-invoke",
          channel: CHANNELS.PLUGIN_INVOKE,
          result: "restricted",
          errorMessage: `untrusted sender (url=${safeUrl})`,
          argsHash: "",
          durationMs: Date.now() - start,
        });
        throw new Error(`plugin:invoke rejected: untrusted sender (url=${senderUrl ?? "unknown"})`);
      }
      const ctx: PluginIpcContext = {
        projectId: null,
        worktreeId: null,
        webContentsId: event.sender.id,
        pluginId,
      };
      try {
        return await (await getPluginService()).dispatchHandler(pluginId, channel, ctx, args);
      } catch (err) {
        // A throwing plugin handler is already audited at the dispatch
        // boundary (#10463); recording it again here would double-count the
        // failure. Errors that never reach a handler — schema/permission/
        // no-handler — aren't marked, so the IPC boundary still owns them.
        if (!isAuditedHandlerFailure(err)) {
          // `stableArgsSha256` content-discriminates without persisting any
          // arg bytes — two structurally identical failed invokes hash the
          // same, but distinct args produce distinct hashes. (A summary-based
          // hash via `summarizeMcpArgs` collapses arrays to a constant, which
          // would defeat forensic grouping.)
          let argsHash = "";
          try {
            argsHash = stableArgsSha256(args);
          } catch {
            // Hashing is best-effort — a serialization throw here must not
            // mask the original handler error.
          }
          // An ownership rejection (#10462) is a denied invocation, not a
          // handler failure — record it as "restricted" so it groups with the
          // untrusted-sender rejection above rather than with genuine dispatch
          // errors. The sender already passed `isTrustedRendererUrl`, so the
          // args are from a trusted frame and the forensic `argsHash` is still
          // useful. An ownership error is thrown before any handler runs, so it
          // is never marked as an audited handler failure and always reaches
          // this block.
          safeAppend({
            pluginId,
            actionId: channel,
            recordType: "ipc-invoke",
            channel: CHANNELS.PLUGIN_INVOKE,
            result: isPluginInvokeOwnershipError(err) ? "restricted" : "error",
            errorMessage: formatErrorMessage(err, "plugin:invoke dispatch failed"),
            argsHash,
            durationMs: Date.now() - start,
          });
        }
        throw err;
      }
    }
  );
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

  return () => cleanups.forEach((cleanup) => cleanup());
}
