import fs from "fs/promises";
import path from "path";
import { stripUtf8Bom } from "../../utils/stripUtf8Bom.js";
import { deepFreeze } from "../../utils/deepFreeze.js";
import {
  DEPRECATED_CONTRIBUTION_ALIASES,
  parsePluginManifestForLoad,
} from "../../schemas/plugin.js";
import {
  parseProjectPluginInstanceKey,
  type PluginManifest,
  type PluginOrigin,
} from "../../../shared/types/plugin.js";
import { applicationPreflightKey } from "./projectApplicationPreflight.js";

export interface PluginManifestLoadOptions {
  isBuiltin: boolean;
  origin: PluginOrigin;
  instanceKey?: string;
  checkedManifest?: Readonly<PluginManifest>;
  installedInstance?: boolean;
}

/**
 * A refusal the caller should surface beyond the console: a toast for a
 * reserved namespace, and a `loadError` on an installed plugin's record.
 */
export interface PluginManifestRefusal {
  reason: "reserved-namespace" | "builtin-only-file-editor-slot";
  pluginName: string;
  message: string;
}

export type PluginManifestLoadResult =
  { ok: true; manifest: PluginManifest } | { ok: false; refusal?: PluginManifestRefusal };

/**
 * Read, parse and validate `plugin.json` for one load. Touches no registry and
 * no service state: every refusal comes back for `loadPlugin` to act on, so
 * the identity gates that need the service's maps stay with their owner.
 */
export async function readPluginManifestForLoad(
  pluginDir: string,
  dirName: string,
  opts: PluginManifestLoadOptions
): Promise<PluginManifestLoadResult> {
  const { origin } = opts;
  const manifestPath = path.join(pluginDir, "plugin.json");

  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[PluginService] No plugin.json in ${dirName}, skipping`);
      return { ok: false };
    }
    console.error(`[PluginService] Failed to read ${manifestPath}:`, err);
    return { ok: false };
  }

  let json: unknown;
  try {
    json = JSON.parse(stripUtf8Bom(content));
  } catch {
    console.error(`[PluginService] Invalid JSON in ${manifestPath}`);
    return { ok: false };
  }

  const { result: parseResult, droppedTourIssues } = parsePluginManifestForLoad(
    opts.installedInstance ? "user" : origin,
    json
  );
  if (droppedTourIssues.length > 0) {
    console.warn(
      `[PluginService] Skipping malformed contributes.tours entries in ${dirName}:`,
      droppedTourIssues
    );
  }
  if (!parseResult.success) {
    const namespaceIssue = parseResult.error.issues.find(
      (i) =>
        i.code === "custom" &&
        (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
          "namespace_reserved"
    );
    console.error(`[PluginService] Invalid manifest in ${dirName}:`, parseResult.error.issues);
    if (namespaceIssue) {
      const inferredName = (json as Record<string, unknown>)?.name;
      return {
        ok: false,
        refusal: {
          reason: "reserved-namespace",
          pluginName: String(inferredName ?? dirName),
          message: namespaceIssue.message,
        },
      };
    }
    return { ok: false };
  }

  const manifest = parseResult.data;
  if (opts.installedInstance && manifest.instanceMode !== "project") {
    console.error(
      `[PluginService] ${dirName} was loaded as a project instance but does not declare instanceMode "project" — refusing to load`
    );
    return { ok: false };
  }

  // A slot-backed `contributes.fileEditors` entry is built-in only (#12323):
  // the slot resolves through the builtin view registry compiled into the
  // host bundle, which an installed plugin's renderer never reaches, so
  // accepting it would advertise an Edit mode that mounts nothing. The
  // manifest schema refuses it too; this is the load-time backstop. A
  // view-backed entry mounts the plugin's own view and is open to every
  // origin (#13809).
  if (!opts.isBuiltin && manifest.contributes.fileEditors.some((e) => e.slot !== undefined)) {
    const message =
      'contributes.fileEditors[].slot is only available to built-in plugins — the editor slot resolves through the host-bundled builtin view registry, which an installed plugin\'s renderer cannot register into. Use "view" instead.';
    console.error(`[PluginService] Invalid manifest in ${dirName}: ${message}`);
    return {
      ok: false,
      refusal: { reason: "builtin-only-file-editor-slot", pluginName: manifest.name, message },
    };
  }

  // Discovery validated one manifest; this is a second read of the same file.
  // A rewrite in between — a rebase, an agent edit, a hostile swap — could
  // hand a DIFFERENT plugin the identity the user already knows and trusts.
  // Refuse rather than let a renamed manifest inherit a staged-or-known id.
  if (opts.instanceKey !== undefined) {
    const expected = parseProjectPluginInstanceKey(opts.instanceKey)?.manifestId;
    if (expected !== manifest.name) {
      console.error(
        `[PluginService] Project plugin in ${dirName} declares "${manifest.name}" but was discovered as "${String(expected)}" — refusing to load`
      );
      return { ok: false };
    }
  }
  // The same second read, for an application: a payload its preflight never
  // saw does not register, so nothing of it is published to be taken back.
  // Either side declaring one counts, so a rewrite that adds `application`
  // is caught as well as one that changes it.
  const checked = opts.checkedManifest;
  if (
    checked !== undefined &&
    (checked.application !== undefined || manifest.application !== undefined) &&
    applicationPreflightKey(manifest) !== applicationPreflightKey(checked)
  ) {
    console.warn(
      `[PluginService] Project application in ${dirName} changed on disk while it was being checked (${checked.version} checked, ${manifest.version} found) — not loading it`
    );
    return { ok: false };
  }
  // Manifest-immutability invariant: the parsed manifest is stored on
  // LoadedPlugin.manifest and read across the whole PluginService lifecycle
  // (capability checks, contribution loops, host closures). Deep-freeze it so
  // an accidental in-place mutation of a declared contribution can't poison the
  // shared record. DEV-only (see deepFreeze) — the Readonly<PluginManifest>
  // type below is the compile-time half of the same invariant.
  deepFreeze(manifest);

  // Deprecation surface for the 1.0 freeze: the schema migrates the old
  // `experimental_*` contribution keys to their stable names before
  // validation, so warn (once per alias) when an old manifest is still using
  // them. Inspect the raw JSON because the migrated `manifest` no longer
  // carries the deprecated keys.
  const rawContributes = (json as { contributes?: Record<string, unknown> } | null)?.contributes;
  if (rawContributes && typeof rawContributes === "object") {
    for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
      if (deprecated in rawContributes) {
        console.warn(
          `[PluginService] Plugin "${manifest.name}": contributes.${deprecated} is deprecated — rename it to contributes.${canonical}`
        );
      }
    }
  }
  return { ok: true, manifest };
}
