import fs from "node:fs/promises";
import path from "node:path";
import type {
  PluginRecipeMetadata,
  PluginRecipeMetadataPatch,
  RecipeAutoAssign,
} from "../../../shared/types/project.js";
import { resilientAtomicWriteFile, resilientRename } from "../../utils/fs.js";

/**
 * Sidecar for the user-owned half of a plugin-contributed recipe (#11860).
 *
 * Contributed recipe content is immutable — it lives in the plugin's manifest
 * and is replaced wholesale on every load. But a recipe is still *used*: every
 * run writes `lastUsedAt`/`usageHistory`, and the user can pin one to the empty
 * state or change its auto-assign behaviour. Those writes have nowhere to go in
 * the manifest and must not go to `GlobalFileStore`, whose entries the plugin
 * tier deliberately never joins. They land here instead, keyed by the qualified
 * `{pluginId}.{contributionId}` id.
 *
 * Modelled on {@link GlobalFileStore}: one file, one scalar write tail so
 * concurrently-handled IPC can't interleave a read-modify-write, atomic writes,
 * and a three-way read policy (missing → empty, transient failure → rethrow so
 * a queued mutator can't rewrite the store from an empty base, malformed →
 * quarantine and reset).
 *
 * `pluginId` and `contributionId` are stored as real fields on every record.
 * Uninstall cleanup and startup reconciliation match on those, never on a split
 * of the key — a plugin id is itself dotted, so the key cannot be parsed back
 * into its two halves (#10109).
 */

const METADATA_FILENAME = "plugin-recipe-metadata.json";

/** Matches the renderer-side frecency cap in `recipeStore.runRecipeWithResults`. */
export const MAX_PLUGIN_RECIPE_USAGE_HISTORY = 20;

/**
 * Bumped only for a breaking layout change. A file claiming a HIGHER version was
 * written by a newer Daintree: it is left untouched and read as empty rather
 * than quarantined, so downgrading and re-upgrading doesn't destroy state the
 * newer build still understands.
 */
const CURRENT_SCHEMA_VERSION = 1;

interface PluginRecipeMetadataFile {
  _schemaVersion: number;
  recipes: Record<string, PluginRecipeMetadata>;
}

const AUTO_ASSIGN_VALUES: ReadonlySet<string> = new Set(["always", "never", "prompt"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one persisted record, dropping anything unrecognized. The record is
 * discarded entirely unless its explicit `pluginId`/`contributionId` recompose
 * to exactly the key it is filed under — a mismatch means the file was
 * hand-edited or written by a buggy build, and trusting either half would let
 * one plugin's metadata be attributed to another during purge.
 */
function decodeEntry(key: string, raw: unknown): PluginRecipeMetadata | null {
  if (!isPlainObject(raw)) return null;
  const { pluginId, contributionId } = raw;
  if (typeof pluginId !== "string" || pluginId.length === 0) return null;
  if (typeof contributionId !== "string" || contributionId.length === 0) return null;
  if (`${pluginId}.${contributionId}` !== key) return null;

  const entry: PluginRecipeMetadata = { pluginId, contributionId };
  if (typeof raw.lastUsedAt === "number" && Number.isFinite(raw.lastUsedAt)) {
    entry.lastUsedAt = raw.lastUsedAt;
  }
  if (Array.isArray(raw.usageHistory)) {
    const history = raw.usageHistory
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .slice(-MAX_PLUGIN_RECIPE_USAGE_HISTORY);
    if (history.length > 0) entry.usageHistory = history;
  }
  if (typeof raw.showInEmptyState === "boolean") {
    entry.showInEmptyState = raw.showInEmptyState;
  }
  if (typeof raw.autoAssign === "string" && AUTO_ASSIGN_VALUES.has(raw.autoAssign)) {
    entry.autoAssign = raw.autoAssign as RecipeAutoAssign;
  }
  return entry;
}

export class PluginRecipeMetadataStore {
  private readonly metadataPath: string;

  /**
   * In-memory mirror of the file, so the registry can overlay metadata onto a
   * recipe snapshot synchronously while building a broadcast payload. `null`
   * until {@link initialize} has run; every mutator refreshes it.
   */
  private cache: Record<string, PluginRecipeMetadata> | null = null;

  /** See {@link GlobalFileStore.enqueueRecipesUpdate} — same rationale. */
  private writeTail: Promise<void> = Promise.resolve();

  /**
   * Set when the file on disk claims a schema version this build doesn't
   * understand. Reads already return empty for that case; without this every
   * mutator would then persist its empty view as v1 and destroy state a newer
   * build still uses — so a downgrade-then-run would silently wipe it.
   */
  private readOnly = false;

  /**
   * No resolvable global config dir (an Electron stub with no `getPath`, i.e.
   * a unit test) — the store runs inert rather than guessing a path. Guessing a
   * plausible-looking home-relative one meant test runs wrote into the user's
   * real `~/.daintree` tree, and a production `getPath` failure would have
   * silently relocated everyone's metadata.
   */
  private readonly inert: boolean;

  constructor(private readonly globalConfigDir: string | null) {
    this.inert = globalConfigDir === null;
    this.metadataPath =
      globalConfigDir === null ? "" : path.join(globalConfigDir, METADATA_FILENAME);
  }

  /**
   * Load the file into {@link cache}. Safe to call more than once. A read
   * failure leaves the cache empty and is reported to the caller, which treats
   * plugin recipe metadata as absent for the session rather than failing plugin
   * load — a missing `lastUsedAt` degrades frecency, it doesn't break anything.
   */
  async initialize(): Promise<void> {
    if (this.inert) {
      this.cache = {};
      return;
    }
    this.cache = await this.read();
  }

  /**
   * Synchronous snapshot for the registry's overlay. Empty before
   * {@link initialize} resolves, which reads as "no user overrides yet" — the
   * manifest defaults apply and the first broadcast after init corrects it.
   */
  getAllSync(): Record<string, PluginRecipeMetadata> {
    return this.cache ?? {};
  }

  /**
   * Append one run timestamp for `qualifiedId`, capped at the newest
   * {@link MAX_PLUGIN_RECIPE_USAGE_HISTORY}. Atomic against the freshest on-disk state rather
   * than accepting a whole array from a renderer, so two windows running the
   * same recipe at once can't have one overwrite the other's history with its
   * own stale copy.
   *
   * Resolves `null` when nothing was recorded — an `inert` store (no resolvable
   * global config dir) or a `readOnly` one (file written by a newer build) both
   * skip the updater entirely, and reporting a record that was never persisted
   * would be a lie the caller could act on.
   */
  async recordUse(
    qualifiedId: string,
    pluginId: string,
    contributionId: string,
    timestamp: number
  ): Promise<PluginRecipeMetadata | null> {
    let result: PluginRecipeMetadata | null = null;
    await this.enqueue(async (current) => {
      const existing = current[qualifiedId];
      const history = [...(existing?.usageHistory ?? []), timestamp].slice(
        -MAX_PLUGIN_RECIPE_USAGE_HISTORY
      );
      result = {
        ...(existing ?? { pluginId, contributionId }),
        pluginId,
        contributionId,
        lastUsedAt: timestamp,
        usageHistory: history,
      };
      return { ...current, [qualifiedId]: result };
    });
    return result;
  }

  /**
   * Apply a user preference patch. `null` for a field deletes the override so
   * the manifest default takes over again; an absent key leaves it alone. A
   * record reduced to nothing but its identity is dropped rather than persisted
   * as an empty shell.
   */
  async setUserOverrides(
    qualifiedId: string,
    pluginId: string,
    contributionId: string,
    patch: PluginRecipeMetadataPatch
  ): Promise<PluginRecipeMetadata | null> {
    let result: PluginRecipeMetadata | null = null;
    await this.enqueue(async (current) => {
      const next: PluginRecipeMetadata = {
        ...(current[qualifiedId] ?? {}),
        pluginId,
        contributionId,
      };
      if (patch.showInEmptyState === null) delete next.showInEmptyState;
      else if (patch.showInEmptyState !== undefined) next.showInEmptyState = patch.showInEmptyState;
      if (patch.autoAssign === null) delete next.autoAssign;
      else if (patch.autoAssign !== undefined) next.autoAssign = patch.autoAssign;

      const isEmpty =
        next.lastUsedAt === undefined &&
        next.usageHistory === undefined &&
        next.showInEmptyState === undefined &&
        next.autoAssign === undefined;
      const updated = { ...current };
      if (isEmpty) {
        delete updated[qualifiedId];
        result = null;
      } else {
        updated[qualifiedId] = next;
        result = next;
      }
      return updated;
    });
    return result;
  }

  /**
   * Drop every record belonging to `pluginId`. Called ONLY from the successful
   * branch of an explicit uninstall — never from disable, reload, or a plugin
   * update, where the recipes are expected back and their frecency should
   * survive. Matches on the stored `pluginId` field, so a contribution id
   * containing dots can't be mis-attributed.
   */
  async purgePlugin(pluginId: string): Promise<void> {
    await this.enqueue(async (current) => {
      const next: Record<string, PluginRecipeMetadata> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (entry.pluginId !== pluginId) next[key] = entry;
      }
      return next;
    });
  }

  /**
   * Startup sweep against what is actually installed, catching the two cases a
   * live purge cannot: a plugin update that dropped a contribution id, and an
   * orphan left by a crash between deleting a plugin's files and purging its
   * metadata.
   *
   * The membership cases are enumerated rather than collapsed into a single
   * "keep what we know about" rule, because the safe answer differs per case
   * (#6110):
   *
   * - plugin not installed at all → orphan, drop.
   * - plugin installed and its recipe set is known (it loaded) but this
   *   contribution id is not in that set → dropped by an update, drop.
   * - plugin installed but its recipe set is NOT known (disabled, blocked,
   *   engine-incompatible, or failed to parse) → keep. This is the case that
   *   makes disable non-destructive.
   *
   * The caller must only pass an inventory built from a COMPLETE scan of every
   * plugin root; a partial inventory would read as "not installed" and delete
   * live metadata.
   *
   * Returns whether anything was actually dropped, so the caller can skip
   * announcing a snapshot that did not change — this runs on every startup, and
   * the overwhelmingly common outcome is "nothing to do".
   */
  async reconcile(input: {
    installedPluginIds: ReadonlySet<string>;
    knownQualifiedIdsByPlugin: ReadonlyMap<string, ReadonlySet<string>>;
  }): Promise<boolean> {
    let dropped = 0;
    await this.enqueue(async (current) => {
      const next: Record<string, PluginRecipeMetadata> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (!input.installedPluginIds.has(entry.pluginId)) continue;
        const known = input.knownQualifiedIdsByPlugin.get(entry.pluginId);
        if (known && !known.has(key)) continue;
        next[key] = entry;
      }
      dropped = Object.keys(current).length - Object.keys(next).length;
      return next;
    });
    return dropped > 0;
  }

  private async enqueue(
    updater: (
      current: Record<string, PluginRecipeMetadata>
    ) => Promise<Record<string, PluginRecipeMetadata>>
  ): Promise<void> {
    if (this.inert) return;
    const next = this.writeTail
      .catch(() => {})
      .then(async () => {
        const current = await this.read();
        // Re-checked INSIDE the queue turn: `read()` is what discovers a future
        // schema version, so a store that was fine at construction can become
        // read-only the moment a newer build writes the file underneath it.
        if (this.readOnly) return;
        const updated = await updater(current);
        await this.write(updated);
        this.cache = updated;
      });
    this.writeTail = next;
    return next;
  }

  private async read(): Promise<Record<string, PluginRecipeMetadata>> {
    let content: string;
    try {
      content = await fs.readFile(this.metadataPath, "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {};
      }
      // A transient read failure is not corruption. Returning {} would let a
      // queued mutator rewrite the whole store from an empty base and silently
      // erase every plugin recipe's history (mirrors GlobalFileStore.getRecipes).
      console.error("[PluginRecipeMetadataStore] Failed to read metadata:", error);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      await this.quarantine(error);
      return {};
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.recipes)) {
      await this.quarantine(new Error("metadata file is not a recipe record"));
      return {};
    }
    const version = parsed._schemaVersion;
    if (typeof version === "number" && version > CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[PluginRecipeMetadataStore] Ignoring metadata written by a newer build (v${version}); this session will not write to it.`
      );
      this.readOnly = true;
      return {};
    }
    this.readOnly = false;

    const decoded: Record<string, PluginRecipeMetadata> = {};
    for (const [key, raw] of Object.entries(parsed.recipes)) {
      const entry = decodeEntry(key, raw);
      if (entry) decoded[key] = entry;
    }
    return decoded;
  }

  private async write(recipes: Record<string, PluginRecipeMetadata>): Promise<void> {
    // Unreachable when inert: `enqueue` is the only caller and returns early.
    if (this.globalConfigDir === null) return;
    const payload: PluginRecipeMetadataFile = { _schemaVersion: CURRENT_SCHEMA_VERSION, recipes };
    const serialized = JSON.stringify(payload, null, 2);
    try {
      await resilientAtomicWriteFile(this.metadataPath, serialized, "utf-8");
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) throw error;
      await fs.mkdir(this.globalConfigDir, { recursive: true });
      await resilientAtomicWriteFile(this.metadataPath, serialized, "utf-8");
    }
  }

  private async quarantine(error: unknown): Promise<void> {
    console.error("[PluginRecipeMetadataStore] Failed to parse metadata:", error);
    try {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await resilientRename(this.metadataPath, `${this.metadataPath}.corrupted.${suffix}`);
    } catch {
      // Ignore — the next write replaces the file anyway.
    }
  }
}
