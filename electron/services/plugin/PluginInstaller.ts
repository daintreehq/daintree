import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import * as semver from "semver";
import { createRequire as nodeCreateRequire } from "node:module";

import {
  getPluginManifestSchema,
  isPrivateOrLoopbackHostname,
  SCOPED_PLUGIN_NAME_PATTERN,
} from "../../schemas/plugin.js";
import { extractPluginArchive, computeArchiveHash, readArchiveManifest } from "../PluginArchive.js";
import { MAX_DNTR_BYTES } from "../../utils/pluginArchiveConstants.js";
import {
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  acceptedMime,
  dntrSuffixOk,
  fetchWithPrivateHostGuard,
} from "../../utils/pluginDownloadPolicy.js";
import { resilientRename } from "../../utils/fs.js";
import { getPluginMcpSupervisor } from "../PluginMcpSupervisor.js";
import { getPluginMcpConsentService, getPluginMcpRateLimiter } from "../plugin-mcp/instances.js";
import { getPluginCapabilityConsentService } from "../plugin-capability/instances.js";
import type {
  PluginManifest,
  PluginInstallError,
  PluginInstallErrorCode,
  PluginInstallResult,
  PluginInstallOptions,
  PluginCheckUpdateResult,
  InstalledPluginRecord,
} from "../../../shared/types/plugin.js";
import type { PluginInstalledRecordsStore } from "./PluginInstalledRecordsStore.js";

// proper-lockfile is CJS-only and ships no bundled types. Require it via the
// same createRequire interop as ajv and declare the narrow surface we use.
interface LockOptions {
  stale?: number;
  update?: number;
  realpath?: boolean;
  retries?: number | { retries: number; minTimeout?: number; maxTimeout?: number };
  onCompromised?: (err: Error) => void;
}
interface ProperLockfile {
  lock(file: string, opts?: LockOptions): Promise<() => Promise<void>>;
}
const req = nodeCreateRequire(import.meta.url);
const properLockfile: ProperLockfile = req("proper-lockfile");

/**
 * Matches the `<pluginId>.old-<uuid>` parked-old dir {@link PluginInstaller._swapPluginDir}
 * stages aside during an upgrade. The trailing `.old-<uuidv4>` suffix is the
 * discriminator: a real plugin dir is exactly `publisher.name`
 * (`SCOPED_PLUGIN_NAME_PATTERN`), which can never end with `.old-` + a hyphenated
 * UUID, so this can't reap a legitimate install. The leading dot is optional so
 * the same regex also covers crash-leftover `.old-<uuid>` names.
 */
const STALE_PARKED_OLD_RE = /\.old-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minimal view of a loaded plugin the installer needs — only `isBuiltin` is
 * read (to decide whether the on-disk dir is the installer's to delete). The
 * full {@link LoadedPlugin} stays core-owned in PluginService.
 */
interface InstallerPluginInfo {
  isBuiltin: boolean;
}

interface PluginInstallerDeps {
  /** User plugins root — the only directory the installer mutates. */
  getPluginsRoot: () => string;
  /** Running Daintree version, for the engine-compatibility gate. */
  getAppVersion: () => string;
  /** Persisted provenance record CRUD + disabled-list reads. */
  records: PluginInstalledRecordsStore;
  /** Per-(plugin,scope) user-settings file root — uninstall optionally deletes the file. */
  getSettingsRoot: () => string;
  /** Core lifecycle callbacks — reached purely through injection so no PluginService back-reference. */
  loadPlugin: (
    root: string,
    pluginId: string,
    opts: { isBuiltin: boolean; disabled: Set<string> }
  ) => Promise<unknown>;
  unloadPlugin: (pluginId: string) => void;
  activatePlugin: (pluginId: string) => Promise<void>;
  setPluginArchiveHash: (pluginId: string, archiveHash: string) => void;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  broadcastProvenanceChanged: () => void;
  /** Lookup for the running or skipped-at-launch plugin (only `isBuiltin` is consumed). */
  getPlugin: (pluginId: string) => InstallerPluginInfo | undefined;
  /** Shared launch-time name reservation set — stays PluginService-owned (read by a test cast). */
  reservedNames: Set<string>;
  /** Shared skipped-at-launch manifest map — stays PluginService-owned. */
  disabledPlugins: Map<string, unknown>;
}

/**
 * Owns the atomic install/upgrade orchestration (lockfile, temp-dir staging,
 * manifest re-validation, engine check, archive hashing, atomic dir swap +
 * parked-old rollback, post-swap load-failure rollback), the manual
 * update-check download/hash/compare flow, the uninstall flow (unload + on-disk
 * delete + consent purge + MCP shutdown + record removal), and the stale
 * temp-dir sweep at init. Reaches core lifecycle purely through the injected
 * callback bag, so it never imports PluginService — breaking the cycle.
 */
export class PluginInstaller {
  private readonly deps: PluginInstallerDeps;

  constructor(deps: PluginInstallerDeps) {
    this.deps = deps;
  }

  private get pluginsRoot(): string {
    return this.deps.getPluginsRoot();
  }

  private get appVersion(): string {
    return this.deps.getAppVersion();
  }

  private get records(): PluginInstalledRecordsStore {
    return this.deps.records;
  }

  /**
   * Best-effort removal of `.install-tmp-*`, `.update-check-*`, leading-dot
   * `.old-*`, and `<pluginId>.old-<uuid>` parked dirs left under the user
   * {@link PluginInstallerDeps.getPluginsRoot} by a crash mid-install,
   * mid-update-check, or mid-swap. The parked-old copy {@link _swapPluginDir}
   * stages is named `<finalDir>.old-<uuid>`, so its basename ends with
   * `.old-<uuid>` rather than starting with `.old-` — the {@link STALE_PARKED_OLD_RE}
   * suffix match reaps those too, while the leading-dot match keeps reaping any
   * older `.old-*` leftovers. Safe because initialize() runs before any install
   * can begin this session, so these are always stale leftovers — and never
   * touches the built-in or sideload roots. Failures are non-fatal.
   */
  async sweepStalePluginTempDirs(): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(this.pluginsRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[PluginService] Failed to scan for stale plugin temp dirs:", err);
      }
      return;
    }

    const stale = entries.filter(
      (e) =>
        e.isDirectory() &&
        (e.name.startsWith(".install-tmp-") ||
          e.name.startsWith(".update-check-") ||
          e.name.startsWith(".old-") ||
          STALE_PARKED_OLD_RE.test(e.name))
    );

    await Promise.all(
      stale.map(async (e) => {
        const dir = path.join(this.pluginsRoot, e.name);
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[PluginService] Failed to reap stale plugin temp dir ${dir}:`, err);
        }
      })
    );
  }

  /**
   * Revoke every TOFU consent pin for a plugin, durably. Shared by the uninstall
   * flow and the upgrade path: a plugin's MCP consent pins are keyed by
   * `(pluginId, serverId, toolName)` and survive a same-id reinstall/upgrade, so
   * any code change must reset them or the new code silently inherits the prior
   * version's approvals (a consent bypass; #10518).
   *
   * Durable + best-effort: if the in-memory drop succeeds but the persist fails,
   * the pins rehydrate on the next launch and the bypass returns —
   * `revokeAllForPlugin` returns whether the snapshot persisted, so retry once on
   * a transient failure, then surface it loudly rather than swallow it. A failed
   * purge must NEVER strand the caller (uninstall still deletes the dir; upgrade
   * still installs): the worst case is a skipped re-prompt the user can revoke
   * manually from the consent settings. `context` names the caller in the logs.
   */
  private _purgeConsentPins(pluginId: string, context: "uninstall" | "upgrade"): void {
    try {
      const consent = getPluginMcpConsentService();
      const purged = consent.revokeAllForPlugin(pluginId) || consent.revokeAllForPlugin(pluginId);
      if (!purged) {
        console.error(
          `[PluginService] consent purge for "${pluginId}" (${context}) failed to persist after a retry; stale TOFU pins may rehydrate on restart — revoke them manually from plugin-MCP consent settings`
        );
      }
    } catch (err) {
      console.error(`[PluginService] consent purge during ${context} of "${pluginId}" threw:`, err);
    }
  }

  /**
   * Atomically install a plugin from a `.dntr` archive path or a pre-extracted
   * directory. This is the ONLY path that mutates {@link PluginInstallerDeps.getPluginsRoot}
   * — direct IPC writes to the plugins directory are a review blocker (#9292).
   *
   * The flow, with rollback on every failure branch:
   * 1. Acquire the cross-process `install.lock` (sub-30s stale TTL so a crashed
   *    prior install can't hold it forever). A second instance blocks, not races.
   * 2. Extract / copy the source into a sibling `.install-tmp-*` dir — same
   *    filesystem as the final location so the eventual rename is atomic.
   * 3. Validate `plugin.json` with the strict Zod schema (unknown keys, reserved
   *    `daintree.*` namespace, publisher/name agreement) and the engine range.
   * 4. Compute the `.dntr` SHA-256 for the `archiveHash` provenance field.
   * 5. If the id already exists: `unloadPlugin` (disposer cascade), then swap via
   *    rename — park old aside → move new in → restore old on failure. Per-plugin
   *    settings/secrets live under a separate `plugin-settings/` root, so the
   *    directory swap never touches them; no preserve/restore step is needed.
   * 6. On any failure the temp dir is removed, the lock released, and a structured
   *    error returned. The on-disk plugin directory is never left half-written.
   *
   * Structured validation errors are RETURNED as `{ status: "failed", errors }`
   * data, never thrown, so they survive the IPC structured-clone boundary
   * intact (#3769) for the F22/F23/F24 install dialogs.
   */
  async installPlugin(
    archivePath: string,
    opts?: PluginInstallOptions
  ): Promise<PluginInstallResult> {
    const fail = (code: PluginInstallErrorCode, message: string): PluginInstallResult => ({
      status: "failed",
      errors: [{ code, message }],
    });

    await fs.mkdir(this.pluginsRoot, { recursive: true });

    const lockPath = path.join(this.pluginsRoot, "install.lock");
    // Set if proper-lockfile reports the lock was compromised mid-hold (mtime
    // drift, external deletion). When that happens a second instance could
    // reclaim the lock, so we abort before the irreversible swap step rather
    // than risk two installs racing on the same directory. Re-throwing inside
    // `onCompromised` is unsafe — it fires from a timer and would surface as an
    // uncaught exception — so we flag and check at the commit point instead.
    let lockCompromised = false;
    // Definitely assigned below or the catch returns, so the `finally` can
    // release unconditionally without a null guard.
    let release: () => Promise<void>;
    try {
      release = await properLockfile.lock(lockPath, {
        // Sub-30s stale TTL with mid-hold refresh every 10s. A crashed prior
        // install's lock is reclaimed after 20s instead of being held forever.
        stale: 20_000,
        update: 10_000,
        // The lock target need not pre-exist — proper-lockfile creates
        // `install.lock.lock` adjacent. `realpath: false` skips the existence
        // probe that would otherwise reject before the lock dir is made.
        realpath: false,
        retries: { retries: 5, minTimeout: 100, maxTimeout: 1_000 },
        onCompromised: (err) => {
          lockCompromised = true;
          console.error("[PluginService] install.lock compromised during install:", err);
        },
      });
    } catch (err) {
      return fail(
        "lock_failed",
        `Couldn't acquire the plugin install lock: ${(err as Error).message}`
      );
    }

    let tmpDir: string | null = null;
    try {
      tmpDir = await fs.mkdtemp(path.join(this.pluginsRoot, ".install-tmp-"));

      // 1. Materialize the plugin into the temp dir.
      let sourceIsDir: boolean;
      try {
        sourceIsDir = (await fs.stat(archivePath)).isDirectory();
      } catch (err) {
        return fail("archive_invalid", `Install source not found: ${(err as Error).message}`);
      }

      let hash: string | null = null;
      if (sourceIsDir) {
        try {
          await fs.cp(archivePath, tmpDir, { recursive: true });
        } catch (err) {
          return fail(
            "archive_invalid",
            `Failed to copy plugin directory: ${(err as Error).message}`
          );
        }
      } else {
        try {
          await extractPluginArchive(archivePath, tmpDir);
        } catch (err) {
          return fail("archive_invalid", `Failed to extract archive: ${(err as Error).message}`);
        }
        try {
          hash = await computeArchiveHash(archivePath);
        } catch (err) {
          return fail("hash_failed", `Failed to compute archive hash: ${(err as Error).message}`);
        }
      }

      // 2. Read + strictly validate the manifest.
      let rawManifest: string;
      try {
        rawManifest = await fs.readFile(path.join(tmpDir, "plugin.json"), "utf-8");
      } catch {
        return fail("manifest_invalid", "plugin.json not found at the archive root");
      }
      let json: unknown;
      try {
        json = JSON.parse(rawManifest);
      } catch {
        return fail("manifest_invalid", "plugin.json is not valid JSON");
      }
      const parsed = getPluginManifestSchema(false).safeParse(json);
      if (!parsed.success) {
        const errors: PluginInstallError[] = parsed.error.issues.map((issue) => {
          const isNamespace =
            issue.code === "custom" &&
            (issue as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
              "namespace_reserved";
          return {
            code: isNamespace ? "namespace_unauthorized" : "manifest_invalid",
            path: issue.path.map(String),
            message: issue.message,
          };
        });
        return { status: "failed", errors };
      }
      const manifest = parsed.data;

      // 3. Engine compatibility.
      const requiredRange = manifest.engines?.daintree;
      if (
        requiredRange &&
        !semver.satisfies(this.appVersion, requiredRange, { includePrerelease: true })
      ) {
        return fail(
          "engine_incompatible",
          `Plugin requires Daintree ${requiredRange} but the running version is ${this.appVersion}`
        );
      }

      // 4. Atomic swap into the final location.
      const pluginId = manifest.name;
      const finalDir = path.join(this.pluginsRoot, pluginId);
      let existing = false;
      try {
        await fs.access(finalDir);
        existing = true;
      } catch {
        existing = false;
      }

      // Reject a name collision BEFORE the swap (#10518). The `existing` probe
      // only sees the user plugins root, so without this a `.dntr` whose id
      // matches a built-in (never in the user root) or a launch-reserved name
      // whose dir was removed would be swapped in, then rejected at load — and
      // on a fresh install the rollback leaves a broken dir behind, a permanent
      // collision on every future scan. A built-in can never be replaced; a
      // reserved name with no on-disk dir (`!existing`) isn't ours to claim.
      // Returning here (before the swap) leaves nothing on disk — the temp dir
      // is reaped by the `finally`.
      if (this.deps.getPlugin(pluginId)?.isBuiltin) {
        return fail(
          "name_collision",
          `"${pluginId}" is a built-in plugin and can't be replaced by an installed one`
        );
      }
      if (!existing && this.deps.reservedNames.has(pluginId)) {
        return fail(
          "name_collision",
          `"${pluginId}" conflicts with a reserved plugin name and can't be installed`
        );
      }

      // Abort before the irreversible swap if the lock was compromised — a
      // second instance may now hold it and racing the rename would corrupt
      // the directory. Nothing has been written to the final location yet.
      if (lockCompromised) {
        return fail("lock_failed", "Install lock was compromised mid-install; aborted before swap");
      }

      if (existing) {
        try {
          this.deps.unloadPlugin(pluginId);
        } catch (err) {
          return fail(
            "unload_failed",
            `Failed to unload the existing "${pluginId}" before upgrade: ${(err as Error).message}`
          );
        }
      }

      const { error: swapError, parked } = await this._swapPluginDir(tmpDir, finalDir, existing);
      if (swapError) {
        // On a recoverable upgrade failure the old directory was restored on
        // disk, but `unloadPlugin` already tore down its runtime state. Re-load
        // it so the previous version stays live this session (rollback must
        // restore runtime state too, not just disk). `swap_unrecoverable` means
        // the directory may be missing — don't attempt a reload there.
        if (existing && swapError.code === "swap_failed") {
          try {
            const restored = await this.deps.loadPlugin(this.pluginsRoot, pluginId, {
              isBuiltin: false,
              disabled: this.records.getDisabledIds(),
            });
            if (restored) await this.deps.activatePlugin(pluginId);
          } catch (reloadErr) {
            console.error(
              `[PluginService] Failed to restore "${pluginId}" runtime state after swap rollback:`,
              reloadErr
            );
          }
        }
        return { status: "failed", errors: [swapError] };
      }
      // The temp dir was renamed into place — drop the handle so the `finally`
      // cleanup doesn't delete the freshly installed plugin.
      tmpDir = null;

      // An upgrade replaces the plugin's code under the SAME id, but its TOFU
      // consent pins are keyed by `(pluginId, serverId, toolName)` — stable
      // across the swap. Without a purge a compromised "latest" archive inherits
      // the prior version's MCP approvals (a consent bypass; #10518). Treat any
      // code change as a trust reset: revoke unconditionally on every upgrade so
      // the new code must re-prompt, mirroring the uninstall purge. Done after
      // the swap (the new code is now on disk) and before it loads/activates, so
      // it can't use a stale pin. Best-effort + durable: a failed persist is
      // logged loudly but never strands the install (worst case is a skipped
      // re-prompt the user can revoke manually).
      if (existing) {
        this._purgeConsentPins(pluginId, "upgrade");
      }

      // 5. Persist provenance and load the new plugin. On an upgrade over an
      // existing install (the swap path) preserve the original `installedAt`
      // and record `updatedAt` instead — `upsertInstalledRecord` spreads over
      // the prior record, so omitting `installedAt` from the patch keeps it.
      // Clear any prior update signal: the user just reinstalled, so whatever
      // `updateAvailable` flagged is now resolved (#9297).
      //
      // Capture the prior record first: the new provenance is written before
      // `loadPlugin`, so a post-swap load failure on an upgrade must restore the
      // OLD record alongside the OLD directory — otherwise Settings and
      // `checkForUpdate` would baseline against the version that never loaded.
      const previousRecord = existing ? this.records.getInstalledRecord(pluginId) : undefined;
      this.records.upsertInstalledRecord(pluginId, {
        source: opts?.source ?? "sideload",
        originalUrl: opts?.originalUrl ?? null,
        archiveHash: hash,
        loadError: null,
        ...(existing
          ? { updatedAt: Date.now(), updateAvailable: null }
          : { installedAt: Date.now() }),
      });

      // A plugin disabled in Preferences installs to disk but is intentionally
      // not loaded this session (`loadPlugin` would return null for it). The
      // files and provenance are committed, so this is a successful install.
      // The new dir is already in place, so the parked old copy (if this was an
      // upgrade) must be reaped HERE before the early return — otherwise it
      // leaks, and its `<pluginId>.old-<uuid>` name is later scanned as a stray
      // plugin dir. Best-effort: a failure only leaks a parked dir the startup
      // sweep reaps.
      if (this.records.getDisabledIds().has(pluginId)) {
        if (parked) {
          await fs.rm(parked, { recursive: true, force: true }).catch((err) => {
            console.warn(`[PluginService] Failed to remove parked old plugin dir ${parked}:`, err);
          });
        }
        this.deps.broadcastProvenanceChanged();
        return { status: "installed", pluginId };
      }

      let loaded: unknown;
      try {
        loaded = await this.deps.loadPlugin(this.pluginsRoot, pluginId, {
          isBuiltin: false,
          disabled: this.records.getDisabledIds(),
        });
      } catch (err) {
        // A manifest field that passes the schema but throws downstream (e.g. a
        // malformed `when` expression rejected by the when-clause parser) must
        // surface as a structured result, not an unhandled rejection. The new
        // version never loaded; on an upgrade, roll back to the parked old one.
        return this._rollbackPostSwapLoadFailure(
          pluginId,
          finalDir,
          existing ? parked : null,
          previousRecord,
          `Plugin "${pluginId}" installed but failed to load: ${(err as Error).message}. Retry from Settings.`
        );
      }
      if (!loaded) {
        // The new version's manifest never loaded. On a fresh install the dir is
        // intact and the user can retry; on an upgrade, roll back to the parked
        // old version so the previous install isn't lost.
        return this._rollbackPostSwapLoadFailure(
          pluginId,
          finalDir,
          existing ? parked : null,
          previousRecord,
          `Plugin "${pluginId}" installed but failed to load. Retry from Settings.`
        );
      }

      // The new version loaded — the parked old copy is no longer needed.
      // Remove it best-effort; a failure here only leaks a `<pluginId>.old-<uuid>`
      // dir, which the startup sweep (STALE_PARKED_OLD_RE) reaps, never the
      // installed plugin.
      if (parked) {
        await fs.rm(parked, { recursive: true, force: true }).catch((err) => {
          console.warn(`[PluginService] Failed to remove parked old plugin dir ${parked}:`, err);
        });
      }

      // setPluginArchiveHash requires the plugin to be loaded; call it after.
      if (hash) this.deps.setPluginArchiveHash(pluginId, hash);
      await this.deps.activatePlugin(pluginId);

      this.deps.broadcastProvenanceChanged();
      return { status: "installed", pluginId };
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[PluginService] Failed to clean up install temp dir ${tmpDir}:`, err);
        });
      }
      await release().catch((err) => {
        console.warn("[PluginService] Failed to release install lock:", err);
      });
    }
  }

  /**
   * Roll back a post-swap `loadPlugin` failure during {@link installPlugin}. The
   * new version's directory is already on disk but never loaded its runtime
   * state, so there's nothing to unload. On a fresh install (`parked === null`)
   * the broken directory is left in place for retry. On an upgrade the broken
   * `finalDir` is removed and the parked old version restored, then re-loaded +
   * re-activated so the previous version stays live this session (disk AND
   * runtime, mirroring the swap_failed rollback). If the restore rename itself
   * fails we leave the new (broken) dir in place rather than escalate to data
   * loss, and return the load_failed error either way.
   *
   * The new provenance record was already written before the failed load, so on
   * an upgrade the captured `previousRecord` is restored alongside the directory
   * — otherwise Settings and `checkForUpdate` would baseline against the version
   * that never loaded. Restored only when the directory restore succeeds: if the
   * new (broken) dir is left in place, its record must stay too so they agree.
   */
  private async _rollbackPostSwapLoadFailure(
    pluginId: string,
    finalDir: string,
    parked: string | null,
    previousRecord: InstalledPluginRecord | undefined,
    message: string
  ): Promise<PluginInstallResult> {
    const failed: PluginInstallResult = {
      status: "failed",
      errors: [{ code: "load_failed", message }],
    };

    if (!parked) return failed;

    // Move the broken new dir ASIDE before restoring the old one, so `finalDir`
    // is never left missing if the restore rename fails. Deleting `finalDir`
    // first (then renaming `parked` back) would lose BOTH versions on a rename
    // failure. The aside reuses the parked `.old-<uuid>` naming so the startup
    // sweep reaps it if we crash in the micro-window between the two renames.
    const brokenAside = `${finalDir}.old-${randomUUID()}`;
    try {
      await resilientRename(finalDir, brokenAside);
    } catch (asideErr) {
      // Couldn't even move the broken dir aside — nothing was destroyed (broken
      // new + parked old both remain on disk); report and let the user retry.
      console.error(
        `[PluginService] Failed to move aside broken "${pluginId}" during rollback:`,
        asideErr
      );
      return failed;
    }
    try {
      await resilientRename(parked, finalDir);
    } catch (restoreErr) {
      // Restore failed — put the broken dir back so `finalDir` isn't missing,
      // then report. (The parked old copy stays on disk under its `.old-<uuid>`
      // name; the next startup sweep reaps it.)
      await resilientRename(brokenAside, finalDir).catch(() => {});
      console.error(
        `[PluginService] Failed to restore previous "${pluginId}" after a post-swap load failure:`,
        restoreErr
      );
      return failed;
    }
    // Old version is back in place — drop the broken copy best-effort.
    await fs.rm(brokenAside, { recursive: true, force: true }).catch(() => {});

    // The old directory is back — restore its provenance record so it matches
    // what's on disk. `previousRecord` is always defined on the upgrade path
    // (a parked dir implies a prior install), but guard defensively.
    if (previousRecord) {
      const records = this.records.getInstalledRecords();
      records[pluginId] = previousRecord;
      this.records.writeInstalledRecords(records);
    }

    try {
      const restored = await this.deps.loadPlugin(this.pluginsRoot, pluginId, {
        isBuiltin: false,
        disabled: this.records.getDisabledIds(),
      });
      if (restored) await this.deps.activatePlugin(pluginId);
    } catch (reloadErr) {
      console.error(
        `[PluginService] Failed to restore "${pluginId}" runtime state after a post-swap load failure:`,
        reloadErr
      );
    }
    return failed;
  }

  /**
   * Atomic directory swap for {@link installPlugin}. On success returns
   * `{ error: null, parked }` where `parked` is the path the previous version
   * was moved aside to (or `null` on a fresh install); the caller deletes it
   * only after the new version loads, so a post-swap load failure can restore
   * the old version. On failure returns `{ error, parked: null }`. When
   * `existing` is true the current `finalDir` is parked aside first and
   * restored if the new directory can't be moved in.
   *
   * `swap_unrecoverable` is reserved for the case where BOTH the move-in AND
   * the restore fail — the plugin directory may be missing and the message
   * says so explicitly rather than swallowing the inconsistency.
   */
  private async _swapPluginDir(
    tmpDir: string,
    finalDir: string,
    existing: boolean
  ): Promise<{ error: PluginInstallError | null; parked: string | null }> {
    const parked = existing ? `${finalDir}.old-${randomUUID()}` : null;

    if (parked) {
      try {
        await resilientRename(finalDir, parked);
      } catch (err) {
        return {
          error: {
            code: "swap_failed",
            message: `Couldn't move the existing plugin aside: ${(err as Error).message}`,
          },
          parked: null,
        };
      }
    }

    try {
      await resilientRename(tmpDir, finalDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const detail =
        code === "EXDEV"
          ? `cross-device rename not supported — the staging dir is on a different filesystem than ${finalDir}`
          : (err as Error).message;
      if (parked) {
        try {
          await resilientRename(parked, finalDir);
        } catch (restoreErr) {
          return {
            error: {
              code: "swap_unrecoverable",
              message: `Install failed (${detail}) and the previous plugin couldn't be restored (${(restoreErr as Error).message}). The directory at ${finalDir} may be missing — reinstall to recover.`,
            },
            parked: null,
          };
        }
      }
      return {
        error: {
          code: "swap_failed",
          message: `Couldn't move the new plugin into place: ${detail}`,
        },
        parked: null,
      };
    }

    // New dir is in place. The parked old copy is NOT deleted here — the caller
    // keeps it until the new version loads so a post-swap load failure can roll
    // back to the previous version.
    return { error: null, parked };
  }

  /**
   * Manual update check (#9297). Re-fetches the plugin's `originalUrl`, hashes
   * the downloaded archive, and compares it against the installed `archiveHash`.
   * Purely informational — it never installs. The user's follow-up is a manual
   * reinstall (via `installFromUrl`), which preserves settings and `installedAt`.
   *
   * Domain failures (no record, no URL, network/content-type/size faults, a
   * malformed archive) are returned as data — never thrown — so the structured
   * result survives the structured-clone IPC boundary (#3769). The download is
   * lock-free: it writes to a private temp dir and reads the hash/manifest, so
   * it doesn't contend with the install lock.
   */
  async checkForUpdate(pluginId: string): Promise<PluginCheckUpdateResult> {
    if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
      return { status: "invalid-id" };
    }
    const record = this.records.getInstalledRecord(pluginId);
    // No record, or a sideload/builtin with no original URL — the UI gates the
    // button on `originalUrl !== null`, so the no-URL case is unreachable in
    // practice; treat it as `invalid-id` defensively.
    if (!record || !record.originalUrl) {
      return { status: "invalid-id" };
    }
    const url = record.originalUrl;
    // Without a baseline hash (corrupt record, or a dir-load that never hashed)
    // there's nothing to compare against — a string never equals `null`, so the
    // diff would always read as "available". Fail loudly instead of misleading.
    if (!record.archiveHash) {
      return { status: "fetch-failed", message: "No baseline archive hash to compare against" };
    }
    const baselineHash = record.archiveHash;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      return { status: "fetch-failed", message: `Invalid update URL: ${(err as Error).message}` };
    }
    if (isPrivateOrLoopbackHostname(parsedUrl.hostname)) {
      return {
        status: "fetch-failed",
        message: "Refusing to fetch a private or loopback address",
      };
    }

    // `net` requires a full Electron runtime; lazy-import it so the service
    // module stays importable in unit tests that don't fetch.
    const { net } = await import("electron");

    let tmpRoot: string | null = null;
    try {
      try {
        await fs.mkdir(this.pluginsRoot, { recursive: true });
        tmpRoot = await fs.mkdtemp(path.join(this.pluginsRoot, ".update-check-"));
      } catch (err) {
        return {
          status: "fetch-failed",
          message: `Failed to prepare update-check directory: ${(err as Error).message}`,
        };
      }
      const tmpArchive = path.join(tmpRoot, "plugin.dntr");

      // Follow redirects manually so every hop's host is revalidated through the
      // private/loopback guard — the original-host check above is bypassable by
      // a public URL that 30x-redirects to loopback/link-local/RFC1918 (SSRF).
      // The guard also re-resolves each hop's DNS and rejects a private resolved
      // IP, closing the DNS-rebinding TOCTOU (#10518); a sub-ms residual remains
      // because net.fetch re-resolves independently (see pluginDownloadPolicy).
      let response: Awaited<ReturnType<typeof net.fetch>>;
      try {
        const guarded = await fetchWithPrivateHostGuard(net.fetch, url, {
          signal: AbortSignal.timeout(PLUGIN_DOWNLOAD_TIMEOUT_MS),
        });
        if (!guarded.ok) {
          return {
            status: "fetch-failed",
            message:
              guarded.reason === "private-redirect" || guarded.reason === "private-host"
                ? "Refusing to fetch an update from a private or loopback address"
                : guarded.reason === "insecure-protocol"
                  ? "Refusing to fetch an update over an insecure (non-https) URL"
                  : "The update URL followed too many redirects",
          };
        }
        response = guarded.response as Awaited<ReturnType<typeof net.fetch>>;
      } catch (err) {
        return {
          status: "fetch-failed",
          message: `Couldn't reach ${url}: ${(err as Error).message}`,
        };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { status: "fetch-failed", message: `Server responded with HTTP ${response.status}` };
      }

      // Content-type guard — shared with the install flow so a server that
      // passes this check also passes a follow-up reinstall. Accept any of the
      // shared archive MIME types, or fall back to a URL path ending in `.dntr`
      // (checked on the original URL, since response.url is unreliable here).
      const contentType = response.headers.get("content-type") ?? "";
      if (!acceptedMime(contentType) && !dntrSuffixOk(parsedUrl.pathname)) {
        await response.body?.cancel().catch(() => {});
        return {
          status: "fetch-failed",
          message: `Unexpected content type "${contentType.split(";")[0].trim().toLowerCase()}"`,
        };
      }

      // Stream to disk with a running byte counter so an oversized body is
      // aborted before the whole 30 MB is written (defense in depth ahead of
      // `computeArchiveHash`'s stat-based cap).
      const body = response.body;
      if (!body) {
        return { status: "fetch-failed", message: "Response had no body" };
      }
      // A read/write fault mid-stream must come back as a structured
      // `fetch-failed`, not a thrown rejection — the "never throws for domain
      // outcomes" contract (#3769). A `null` sentinel signals the oversize abort
      // so the early-return stays out of the catch.
      let oversized = false;
      try {
        const handle = await fs.open(tmpArchive, "w");
        try {
          const reader = body.getReader();
          let bytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            bytes += value.byteLength;
            if (bytes > MAX_DNTR_BYTES) {
              await reader.cancel().catch(() => {});
              oversized = true;
              break;
            }
            await handle.write(value);
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        return {
          status: "fetch-failed",
          message: `Couldn't download the archive: ${(err as Error).message}`,
        };
      }
      if (oversized) {
        return {
          status: "fetch-failed",
          message: `Archive exceeds the ${MAX_DNTR_BYTES}-byte size limit`,
        };
      }

      let downloadedHash: string;
      try {
        downloadedHash = await computeArchiveHash(tmpArchive);
      } catch (err) {
        return {
          status: "fetch-failed",
          message: `Couldn't hash the archive: ${(err as Error).message}`,
        };
      }
      if (downloadedHash === baselineHash) {
        return { status: "up-to-date" };
      }

      // Hashes differ — surface the new manifest's preview so the confirm dialog
      // can show what the reinstall would bring in.
      let manifest: PluginManifest;
      try {
        manifest = await readArchiveManifest(tmpArchive);
      } catch (err) {
        return {
          status: "fetch-failed",
          message: `Downloaded archive isn't a valid plugin: ${(err as Error).message}`,
        };
      }
      // The URL must still serve the SAME plugin — a redirected or swapped URL
      // could serve a different archive, and a later reinstall would replace
      // this plugin's directory with a stranger's. Reject the mismatch rather
      // than presenting a foreign plugin as an "update".
      if (manifest.name !== pluginId) {
        return {
          status: "fetch-failed",
          message: `Downloaded archive is for a different plugin ("${manifest.name}")`,
        };
      }
      return {
        status: "available",
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        capabilities: manifest.capabilities ?? [],
      };
    } finally {
      if (tmpRoot) {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch((err) => {
          console.warn(`[PluginService] Failed to clean up update-check temp dir ${tmpRoot}:`, err);
        });
      }
    }
  }

  /**
   * Remove a non-builtin plugin from the running session, delete its on-disk
   * install, and drop its provenance record. Composes the existing
   * `unloadPlugin` (which tears down all of the plugin's contributions and
   * broadcasts the registry changes) with deletion of the plugin directory,
   * optional deletion of its user-scope settings/secrets, and removal of the
   * persisted `plugins.installed` record, then fires a
   * `plugin:provenance-changed` broadcast so every project view's Settings tab
   * re-pulls the list.
   *
   * Holds the same `install.lock` {@link installPlugin} uses, so an install and
   * an uninstall of the same plugin can't race on the directory. A throwing
   * disposer never blocks the on-disk deletion — a broken plugin must still be
   * uninstallable. `deleteSettings` defaults to `false` so stored secrets
   * survive a reinstall; project-scope settings (per-repo `.daintree/`, tracked
   * git artifacts) are never touched. Built-ins are app-bundled with no
   * installed record — their directory is never deleted.
   */
  async uninstallPlugin(pluginId: string, deleteSettings = false): Promise<void> {
    if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
      throw new Error("uninstallPlugin: pluginId must be a non-empty string");
    }
    // Defense-in-depth (the IPC handler validates too): pluginId is joined onto
    // pluginsRoot for `fs.rm`, so reject anything that isn't a scoped plugin
    // name before touching the filesystem — blocks `..` traversal and separators.
    if (!SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
      throw new Error("uninstallPlugin: pluginId must be a scoped plugin name (publisher.name)");
    }
    // Coerce so a non-TypeScript caller can't pass a truthy non-boolean and
    // silently wipe secrets the user meant to keep.
    const wipeSettings = deleteSettings === true;

    // Capture the record (running or skipped-at-launch) before unload clears it
    // so we know whether the on-disk dir is ours to delete — built-ins live in
    // the app bundle and must survive.
    const record = this.deps.getPlugin(pluginId);
    const isBuiltin = record?.isBuiltin ?? false;

    await fs.mkdir(this.pluginsRoot, { recursive: true });

    const lockPath = path.join(this.pluginsRoot, "install.lock");
    // Definitely assigned below or the catch throws, so `finally` can release
    // unconditionally without a null guard.
    let release: () => Promise<void>;
    try {
      release = await properLockfile.lock(lockPath, {
        stale: 20_000,
        update: 10_000,
        realpath: false,
        retries: { retries: 5, minTimeout: 100, maxTimeout: 1_000 },
        onCompromised: (err) => {
          console.error("[PluginService] install.lock compromised during uninstall:", err);
        },
      });
    } catch (err) {
      throw new Error(`Couldn't acquire the plugin install lock: ${(err as Error).message}`, {
        cause: err,
      });
    }

    try {
      // A plugin is either running (`this.plugins`) or skipped-at-launch because
      // it was disabled (`this.disabledPlugins`). `unloadPlugin` only touches the
      // running set, so a disabled plugin must also be dropped from the skipped
      // map below. The disposer cascade already swallows per-step errors, but
      // guard the whole call too: a broken plugin must still be uninstallable.
      try {
        this.deps.unloadPlugin(pluginId);
      } catch (err) {
        console.error(`[PluginService] unloadPlugin during uninstall of "${pluginId}" threw:`, err);
      }

      // `unloadPlugin` fires the MCP shutdown fire-and-forget; await it
      // explicitly here so subprocess handles are released before `fs.rm`
      // (idempotent — re-shutting-down an already-stopped server is a no-op).
      // The await covers the signal path only; the Windows tree-kill grace
      // window is ridden out by the `fs.rm` retry options below.
      try {
        const supervisor = getPluginMcpSupervisor();
        await supervisor.shutdown({ pluginId });
        // Uninstall (not a reload) — drop the supervisor state entries too so
        // the per-server stderr ring / contribution don't leak after the
        // plugin's code is gone. `shutdown` alone keeps the entry for the log
        // viewer; only a full uninstall removes it.
        supervisor.removeState(pluginId);
      } catch (err) {
        console.error(`[PluginService] MCP shutdown during uninstall of "${pluginId}" threw:`, err);
      }

      // Purge every TOFU consent pin for the plugin unconditionally — pluginIds
      // are author-controlled, so a reinstall (or rebuild) must re-prompt rather
      // than inherit prior approvals. Decoupled from `wipeSettings`: stale pins
      // are a consent-bypass risk even when secrets are kept. Shared with the
      // upgrade path so both close the same consent-inheritance gap (#10518).
      this._purgeConsentPins(pluginId, "uninstall");

      // Purge JIT host-capability grants for the same reason — a same-name
      // reinstall must re-prompt on first use of shell:exec / fs:*-write /
      // git:write rather than inherit a prior grant (#10524). Durable by
      // contract: revokeAllForPlugin retries the flush internally, so a single
      // call already covers a transient persist failure (a caller-side
      // `x() || x()` retry would no-op the second call).
      try {
        const capConsent = getPluginCapabilityConsentService();
        const purged = capConsent.revokeAllForPlugin(pluginId);
        if (!purged) {
          console.error(
            `[PluginService] capability consent purge for "${pluginId}" failed to persist after a retry; stale grants may rehydrate on restart — revoke them manually from plugin capability settings`
          );
        }
      } catch (err) {
        console.error(
          `[PluginService] capability consent purge during uninstall of "${pluginId}" threw:`,
          err
        );
      }

      // Drop the plugin's rate-limit buckets so a same-name reinstall starts
      // with a full burst budget instead of inheriting throttle debt.
      try {
        getPluginMcpRateLimiter().dropPlugin(pluginId);
      } catch (err) {
        console.error(
          `[PluginService] rate-limiter drop during uninstall of "${pluginId}" threw:`,
          err
        );
      }

      // Delete the on-disk install. The dir is deterministic — `installPlugin`
      // always materializes to `<pluginsRoot>/<pluginId>` — so this also reaps
      // an orphaned record whose plugin failed to load. `force` makes a missing
      // dir a no-op; the retry options ride out Windows EBUSY/EPERM from handles
      // still closing during the shutdown grace window. Skip built-ins.
      if (!isBuiltin) {
        const pluginDir = path.join(this.pluginsRoot, pluginId);
        await fs.rm(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }

      // Optionally delete user-scope stored settings/secrets. `force` is a safe
      // no-op when the file doesn't exist; the retry options mirror the plugin
      // dir deletion so a still-closing settings writer on Windows doesn't strand
      // the uninstall. The in-memory store was already dropped by
      // `unloadPlugin`'s clearPluginSettingsState step.
      if (wipeSettings) {
        const settingsFile = path.join(this.deps.getSettingsRoot(), `${pluginId}.json`);
        await fs.rm(settingsFile, { force: true, maxRetries: 5, retryDelay: 100 });
      }

      // Bookkeeping runs only after the filesystem deletion succeeds — if `fs.rm`
      // throws, the record stays so the row remains and the user can retry,
      // rather than seeing a "gone" plugin whose files are still on disk.
      this.deps.disabledPlugins.delete(pluginId);
      // Release the launch-time name reservation (set when a disabled plugin is
      // skipped at startup) so a same-session reinstall isn't rejected as a
      // duplicate name.
      this.deps.reservedNames.delete(pluginId);
      // Clear it from the persisted `plugins.disabled` intent list so a disabled
      // plugin can't resurrect itself on the next launch's disabled-dir re-scan.
      await this.deps.setEnabled(pluginId, true);
      const records = this.records.getInstalledRecords();
      if (pluginId in records) {
        delete records[pluginId];
        this.records.writeInstalledRecords(records);
      }
      this.deps.broadcastProvenanceChanged();
    } finally {
      await release().catch((err) =>
        console.warn("[PluginService] Failed to release install.lock after uninstall:", err)
      );
    }
  }
}
