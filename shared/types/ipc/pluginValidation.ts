import type { PluginOrigin } from "../plugin.js";

/** One schema rejection, carrying the field path the author has to go fix. */
export interface PluginManifestIssue {
  /** Dotted field path (`contributes.panels.0.color`), or `(root)`. */
  path: string;
  message: string;
}

/**
 * Result of validating one on-disk `plugin.json` against the real manifest
 * schema — the same Zod schema the loader runs, not a reimplementation of it.
 *
 * `errors` being empty is the whole verdict: `warnings` are advisory and never
 * stop a plugin loading. `origin` is reported rather than assumed because the
 * schema is origin-keyed — a manifest valid under `user` can be refused under
 * `project` and vice versa — so an author reading a rejection needs to know
 * which set of rules produced it.
 */
export interface PluginManifestValidationResult {
  /** Absolute path of the `plugin.json` that was read. */
  manifestPath: string;
  origin: PluginOrigin;
  /**
   * How `origin` was decided. `location` means the directory sits under a real
   * discovery root and the origin is a fact; `declared-scope` means it does not,
   * so the manifest's own `scope` was taken at face value and the verdict is a
   * prediction of what would happen once it is placed.
   */
  originSource: "location" | "declared-scope";
  ok: boolean;
  /** Manifest `name`, when the JSON carried a usable one. */
  pluginId: string | null;
  errors: PluginManifestIssue[];
  warnings: string[];
}
