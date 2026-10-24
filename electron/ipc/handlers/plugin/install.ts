import { BrowserWindow, dialog, net } from "electron";
import { stat, open, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path, { isAbsolute, extname } from "node:path";
import crypto from "node:crypto";
import { CHANNELS } from "../../channels.js";
import { MAX_DNTR_BYTES } from "../../../utils/pluginArchiveConstants.js";
import {
  urlHasCredentials,
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  fetchWithPrivateHostGuard,
  acceptedMime,
  dntrSuffixOk,
} from "../../../utils/pluginDownloadPolicy.js";
import {
  SCOPED_PLUGIN_NAME_PATTERN,
  isPrivateOrLoopbackHostname,
} from "../../../schemas/pluginIdentifiers.js";
import { describePluginInstallSource } from "../../../../shared/utils/pluginInstallSource.js";
import { pluginInstallJobs } from "../../../services/plugin/PluginInstallJobRegistry.js";
import { sendToRendererContext } from "../../utils.js";
import type {
  LoadedPluginInfo,
  PluginInstallResult,
  PluginInstallOptions,
  PluginInstallExpectation,
  PluginInstallError,
  PluginCheckUpdateResult,
  PluginBackgroundUpdateCheckSettings,
  PluginBackgroundUpdateCheckResult,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import { getPluginService } from "./service.js";

export async function handleList(): Promise<LoadedPluginInfo[]> {
  // Same init-race guard as `handleToolbarButtons` (#9285): a mount-time pull
  // (pluginRuntimeStore, plugin manager) before the deferred initialize()
  // populates the maps would cache an empty list — wrong `disabled` gating in
  // the renderer until the next provenance broadcast.
  const pluginService = await getPluginService();
  await pluginService.waitForCatalog();
  return pluginService.listPlugins();
}

export async function handleSetEnabled(pluginId: string, enabled: boolean): Promise<void> {
  // A toggle arriving mid-init finds both `plugins` and `disabledPlugins`
  // unpopulated, mis-classifies a built-in as a user plugin, and silently
  // takes the persist-only path — no live load, no provenance broadcast.
  const pluginService = await getPluginService();
  await pluginService.waitForCatalog();
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
  // Require a REGULAR file before opening it. `open()` on a FIFO blocks forever
  // when no writer exists, and the extension check alone doesn't stop someone
  // dropping a `pipe.dntr` — that would wedge the IPC call and strand its
  // install job with no timeout to rescue it. `stat` follows symlinks, so a
  // symlink to a real archive still installs.
  try {
    if (!(await stat(archivePath)).isFile()) {
      return fail("That path isn't a regular file");
    }
  } catch {
    return fail("Couldn't read the dropped file");
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
export async function handleInstall(
  archivePath: string,
  opts?: PluginInstallOptions
): Promise<PluginInstallResult> {
  const invalid = await validateDntrArchivePath(archivePath);
  if (invalid) return invalid;
  const service = await getPluginService();
  // Same init gate as `handleInstallFromPath` (#11280): `initialize()` assumes no
  // install overlaps it — its sweep deletes staging dirs and the blocklist is
  // still unset. It also keeps the #11728 addressability invariant intact, since
  // an install that beat the deferred task here would publish panel kinds while
  // the `plugin://` resolver was still the 404-everything placeholder.
  await service.waitForCatalog();
  return service.installPlugin(archivePath, opts);
}

// Job ids are renderer-minted UUIDs used only as a correlation key. Bound the
// shape so a hostile renderer can't push unbounded strings into the registry or
// into the log line that echoes the id.
const INSTALL_JOB_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Run an install under an optional progress/cancellation job (#11302).
 *
 * Registration lives here rather than in the install handlers themselves so the
 * exported `handleInstallFromPath` / `handleInstallFromUrl` keep their plain
 * signatures for the CLI server (`PluginCliServer.ts`), which installs with no
 * renderer to report to. Progress is targeted at the initiating window: a
 * background install in another project view must not paint this one's UI.
 *
 * The `finally` is the only place a record is dropped — cancellation merely
 * aborts the signal, and the install's own `finally` still owns the staging
 * directory and the install lock.
 *
 * `run` receives the id to actually use, which is `undefined` whenever the job
 * could not be registered. That matters: the installer resolves its signal by
 * looking the id up in the process-wide registry, so running with an id owned
 * by a DIFFERENT live install would splice the two together — cancelling one
 * would abort the other, either could commit the other's record, and progress
 * would be pushed to the wrong window. Better to install without progress than
 * to install under someone else's job.
 */
async function withInstallJob(
  ctx: IpcContext,
  jobId: string | undefined,
  source: string,
  run: (effectiveJobId: string | undefined) => Promise<PluginInstallResult>
): Promise<PluginInstallResult> {
  if (!jobId || !INSTALL_JOB_ID_PATTERN.test(jobId)) return run(undefined);
  // The renderer can't name a file-picker install on its own — the path only
  // exists here — so every event carries the label.
  const label = describePluginInstallSource(source);
  const registered = pluginInstallJobs.begin(jobId, (event) => {
    sendToRendererContext(ctx, CHANNELS.PLUGIN_INSTALL_PROGRESS, { ...event, source: label });
  });
  if (!registered) return run(undefined);
  try {
    return await run(jobId);
  } finally {
    pluginInstallJobs.end(jobId);
  }
}

/**
 * Abort an in-flight install. Returns false when the job is unknown (already
 * finished, or never existed) or has passed the commit point — the renderer
 * surfaces that as "too late" rather than leaving a Cancel button that silently
 * does nothing.
 */
export function handleCancelInstall(jobId: string): boolean {
  if (typeof jobId !== "string" || !INSTALL_JOB_ID_PATTERN.test(jobId)) return false;
  return pluginInstallJobs.cancel(jobId);
}

// Install-from-file owns the native-picker entry point; the selected path runs
// the SAME trust gate + installer as the drag-and-drop path
// ({@link handleInstallFromPath}) so both renderer entries validate identically.
// A dismissed picker resolves `cancelled`; validation failures come back as
// structured `{ status: "failed" }` data the dialog can render inline.
export async function handleInstallFromFile(
  ctx: IpcContext,
  jobId?: string
): Promise<PluginInstallResult> {
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
  // The job starts once a path exists — time spent in the native picker isn't
  // install progress, and a Cancel button for it would duplicate the picker's own.
  const archivePath = result.filePaths[0]!;
  return withInstallJob(ctx, jobId, archivePath, (id) => handleInstallFromPath(archivePath, id));
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
 * `files.getDroppedFilePaths` bridge and hands it here; main owns every
 * trust gate via {@link validateDntrArchivePath} because the renderer can't be
 * trusted to validate before #9292 runs. All failures come back as structured
 * `{ status: "failed" }` data (never thrown) so the tab can render an inline
 * message.
 */
export async function handleInstallFromPath(
  path: string,
  jobId?: string
): Promise<PluginInstallResult> {
  const invalid = await validateDntrArchivePath(path);
  if (invalid) return invalid;
  const service = await getPluginService();
  // A double-clicked archive can be approved before the deferred plugin-service
  // task finishes (#11280), and `initialize()` assumes no install overlaps it:
  // its startup sweep deletes staging directories and the kill-switch blocklist
  // is still unset. Wait it out — a no-op once init has settled.
  await service.waitForCatalog();
  // Call through with a single argument when there is no job, so the installer
  // sees exactly the same shape it always did.
  return jobId === undefined ? service.installPlugin(path) : service.installPlugin(path, { jobId });
}

/** Namespace entry for install-from-path — registers the job, then delegates. */
export async function handleInstallFromPathOp(
  ctx: IpcContext,
  path: string,
  jobId?: string
): Promise<PluginInstallResult> {
  return withInstallJob(ctx, jobId, path, (id) => handleInstallFromPath(path, id));
}

/** Namespace entry for install-from-URL — registers the job, then delegates. */
export async function handleInstallFromUrlOp(
  ctx: IpcContext,
  url: string,
  jobId?: string,
  expected?: PluginInstallExpectation
): Promise<PluginInstallResult> {
  return withInstallJob(ctx, jobId, url, (id) => handleInstallFromUrl(url, id, expected));
}

const ARCHIVE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isInstallExpectation(value: unknown): value is PluginInstallExpectation {
  if (typeof value !== "object" || value === null) return false;
  const { pluginId, archiveHash } = value as Record<string, unknown>;
  return (
    typeof pluginId === "string" &&
    SCOPED_PLUGIN_NAME_PATTERN.test(pluginId) &&
    typeof archiveHash === "string" &&
    ARCHIVE_HASH_PATTERN.test(archiveHash)
  );
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
 *
 * `expected` binds a confirmed update to the archive its preview was read from
 * (#12612): the installer refuses the download unless its digest and
 * `manifest.name` match. Omitted for ordinary URL installs, including the
 * `daintree-plugin install` CLI, which has no preview step.
 */
export async function handleInstallFromUrl(
  url: string,
  jobId?: string,
  expected?: PluginInstallExpectation
): Promise<PluginInstallResult> {
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

  // A binding that arrives malformed must fail closed — falling back to an
  // unbound install would quietly drop the guarantee the caller asked for.
  if (expected !== undefined && !isInstallExpectation(expected)) {
    return failed(
      "archive_mismatch",
      "The update approval was malformed, so nothing was installed."
    );
  }

  const tempPath = path.join(os.tmpdir(), `daintree-plugin-${crypto.randomUUID()}.dntr`);
  // Redirects are followed MANUALLY so every hop's host is revalidated through
  // the private/loopback guard — the original-host check alone is bypassable by
  // a public URL that 30x-redirects to loopback/link-local/RFC1918 (SSRF). The
  // size controller and the timeout signal both feed a single AbortSignal.any()
  // that's threaded through every hop.
  const sizeController = new AbortController();
  let sizeAborted = false;
  let wroteTempFile = false;

  // The user's cancel joins the size cap and the download deadline on the same
  // composed signal (#11302), so aborting during the download drops the socket
  // instead of waiting for the installer to notice at the next checkpoint.
  const jobSignal = pluginInstallJobs.signal(jobId);
  const cancelledDuringDownload = () => jobSignal?.aborted === true;

  try {
    pluginInstallJobs.setPhase(jobId, "downloading");
    const signal = AbortSignal.any([
      sizeController.signal,
      AbortSignal.timeout(PLUGIN_DOWNLOAD_TIMEOUT_MS),
      ...(jobSignal ? [jobSignal] : []),
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
      // A user cancel aborts the same composed signal as the deadline, so check
      // it first — otherwise cancelling would report a timeout that never happened.
      if (cancelledDuringDownload()) return { status: "cancelled" };
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
      // The size cap sets its own flag above, so anything abort-like left here
      // is either the user's cancel or the deadline — cancel wins.
      if (cancelledDuringDownload()) return { status: "cancelled" };
      if (isAbortLikeError(err)) {
        return failed("fetch_timeout", "The download timed out before it finished.");
      }
      return failed("fetch_failed", "Couldn't download the plugin from that URL.");
    }

    const service = await getPluginService();
    // See `handleInstall` — the same init gate, for the same two reasons.
    await service.waitForCatalog();
    // Awaited, not returned bare: the `finally` below deletes the download, and
    // a bare `return` would run it while the installer is still reading it.
    return await service.installPlugin(tempPath, {
      source: "url",
      originalUrl: trimmed,
      ...(jobId === undefined ? {} : { jobId }),
      ...(expected === undefined
        ? {}
        : { expected: { pluginId: expected.pluginId, archiveHash: expected.archiveHash } }),
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

export async function handleCheckForUpdate(pluginId: string): Promise<PluginCheckUpdateResult> {
  if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
    return { status: "invalid-id" };
  }
  // The service owns the bounded download + hash compare and returns a
  // structured result for every domain outcome (#9297).
  return (await getPluginService()).checkForUpdate(pluginId);
}

export async function handleGetBackgroundUpdateCheckSettings(): Promise<PluginBackgroundUpdateCheckSettings> {
  const { getPluginUpdateCheckService } =
    await import("../../../services/PluginUpdateCheckService.js");
  return getPluginUpdateCheckService().getSettings();
}

export async function handleSetBackgroundUpdateCheckSettings(
  enabled: boolean
): Promise<PluginBackgroundUpdateCheckSettings> {
  const { getPluginUpdateCheckService } =
    await import("../../../services/PluginUpdateCheckService.js");
  const service = getPluginUpdateCheckService();
  // The IPC boundary is untyped at runtime — reject a malformed write without
  // mutating state rather than trusting the declared `boolean`.
  if (typeof enabled !== "boolean") {
    return service.getSettings();
  }
  return service.updateSettings({ enabled });
}

export async function handleGetLatestBackgroundUpdateCheck(): Promise<PluginBackgroundUpdateCheckResult | null> {
  const { getPluginUpdateCheckService } =
    await import("../../../services/PluginUpdateCheckService.js");
  return getPluginUpdateCheckService().getLatest();
}
