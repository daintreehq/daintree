import { dialog, BrowserWindow, app } from "electron";
import { writeFile, realpath, readFile } from "node:fs/promises";
import path, { isAbsolute } from "node:path";
import { getPluginActionAuditService } from "../../../services/PluginActionAuditService.js";
import {
  type PluginActionAuditRecord,
  type PluginAuditConfig,
  PLUGIN_AUDIT_MIN_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
} from "../../../../shared/types/ipc/pluginAudit.js";
import type { PluginDiagnosticsSnapshot } from "../../../../shared/types/ipc/pluginDiagnostics.js";
import type { PluginDataBackupOutcome } from "../../../../shared/types/ipc/pluginDataBackup.js";
import type {
  PluginManifestValidationResult,
  PluginManifestIssue,
} from "../../../../shared/types/ipc/pluginValidation.js";
import { getPluginManifestSchema } from "../../../schemas/plugin.js";
import { collectManifestAdvisories } from "../../../schemas/pluginManifestAdvisories.js";
import { collectPluginIconIssues } from "../../../services/plugin/pluginIconAssets.js";
import { PLUGIN_METHOD_CHANNELS } from "../plugin.preload.js";
import { stripUtf8Bom } from "../../../utils/stripUtf8Bom.js";
import { scrubSecrets } from "../../../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { isTrustedRendererUrl } from "../../../../shared/utils/trustedRenderer.js";
import type { PluginOrigin } from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import {
  isSafePluginInstanceId,
  projectIdFromPluginInstanceKey,
} from "../../../services/plugin/projectPluginIdentity.js";
import { UNTRUSTED_URL_MAX_CHARS, safeAppend } from "./auditAppend.js";
import { getPluginService } from "./service.js";

// ── Plugin-action audit log ───────────────────────────────────────────────

export async function handleGetAuditRecords(): Promise<PluginActionAuditRecord[]> {
  return getPluginActionAuditService().getRecords();
}

export async function handleGetAuditConfig(): Promise<PluginAuditConfig> {
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
export async function handleClearAuditLog(ctx: IpcContext): Promise<void> {
  const senderUrl = ctx.event?.senderFrame?.url;
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

export async function handleSetAuditEnabled(enabled: boolean): Promise<PluginAuditConfig> {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  return getPluginActionAuditService().setEnabled(enabled);
}

export async function handleSetAuditMaxRecords(max: number): Promise<PluginAuditConfig> {
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

export async function handleExportAuditLog(records: PluginActionAuditRecord[]): Promise<boolean> {
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

// ── Manifest validation for plugin authors ────────────────────────────────

/**
 * `PLUGIN_DIR_SEGMENTS` is where a project keeps its committed plugins. Used
 * only to decide the validation origin, never to gate access — a manifest being
 * validated is very often not in its final home yet.
 */
const PROJECT_PLUGIN_DIR_SEGMENTS = [".daintree", "plugins"];

function isPathUnder(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate an arbitrary on-disk `plugin.json` against the real manifest schema
 * so a plugin-authoring agent can read the field paths it got wrong instead of
 * inferring them from a plugin that silently failed to load.
 *
 * Path is confined to the sender's own project root or the managed plugins
 * root. The reply is only a verdict on a file the caller named, but the read
 * itself is the reach — an unconfined path would turn a schema check into a
 * file-existence oracle over the whole filesystem, and the callers this exists
 * for (an agent authoring into `.daintree/plugins/`, a user installing into
 * `~/.daintree/plugins/`) are both inside those roots by construction.
 */
export async function handleValidateManifest(
  ctx: IpcContext,
  targetPath: string
): Promise<PluginManifestValidationResult> {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error("plugin manifest validation: path must be a non-empty string");
  }
  const svc = await getPluginService();
  // Imported lazily, like `getPluginService` above: `ProjectStore` is a module
  // singleton that reads `app.getPath("userData")` as it initializes, so a
  // static import would drag Electron's `app` into every consumer of this
  // module at import time — including tests that mock `electron` and have no
  // reason to know this handler exists.
  const { projectStore } = await import("../../../services/ProjectStore.js");
  const projectRoot = ctx.projectId
    ? (projectStore.getProjectById(ctx.projectId)?.path ?? null)
    : null;
  const pluginsRoot = svc.getPluginsRoot();
  // A relative path is resolved against the project root, never the main
  // process's cwd — the caller is an agent working in the project, and cwd is
  // wherever the app happened to launch from.
  if (!isAbsolute(targetPath) && projectRoot === null) {
    throw new Error(
      `plugin manifest validation: "${targetPath}" is relative and the sender has no open project to resolve it against. Pass an absolute path.`
    );
  }
  const resolved = isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot as string, targetPath);
  const allowedRoots = [projectRoot, pluginsRoot].filter((root): root is string => root !== null);
  const outside = (): Error =>
    new Error(
      `plugin manifest validation: "${targetPath}" is outside this project and the managed plugins directory. Validate a path under ${allowedRoots.join(" or ") || "an open project"}.`
    );
  if (!allowedRoots.some((root) => isPathUnder(path.resolve(root), resolved))) throw outside();

  // Accept either the directory or the manifest itself — an agent that just
  // wrote the file naturally names the file.
  const dir = path.basename(resolved) === "plugin.json" ? path.dirname(resolved) : resolved;
  const manifestPath = path.join(dir, "plugin.json");

  // The lexical check above cannot see a symlink, and a project is a directory
  // of files the user did not necessarily write. Re-check after canonicalising,
  // mirroring `PluginService.isRealpathContained`: a path that resolves outside
  // the allowed roots is refused even though its spelling sits inside them.
  //
  // Both the directory AND the manifest file, because they escape
  // independently: an ordinary directory inside an allowed root can hold a
  // `plugin.json` that is itself a symlink to anywhere, and `readFile` follows
  // it. A path that does not resolve at all is left to the read below, which
  // reports a missing manifest rather than a containment failure.
  const realRoots = await Promise.all(
    allowedRoots.map((root) => realpath(root).catch(() => path.resolve(root)))
  );
  const contained = (candidate: string): boolean =>
    realRoots.some((root) => isPathUnder(root, candidate));
  for (const candidate of [dir, manifestPath]) {
    const real = await realpath(candidate).catch(() => null);
    if (real !== null && !contained(real)) throw outside();
  }

  // Origin is a fact when the directory sits under a real discovery root, and a
  // prediction otherwise. A manifest still being drafted elsewhere in the repo
  // gets checked against the rules it will meet, keyed off its own `scope`.
  //
  // Derived from location BEFORE the file is read, so a manifest that fails to
  // parse still reports the origin its location implies. Keying this off the
  // JSON meant unparseable input was always reported as a user-scope manifest,
  // including one sitting in the project's own plugins directory.
  const projectPluginsDir = projectRoot
    ? path.join(projectRoot, ...PROJECT_PLUGIN_DIR_SEGMENTS)
    : null;
  const locationOrigin: PluginOrigin | null =
    projectPluginsDir && isPathUnder(projectPluginsDir, dir)
      ? "project"
      : isPathUnder(path.resolve(pluginsRoot), dir)
        ? "user"
        : null;

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`plugin manifest validation: no readable plugin.json at ${manifestPath}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(stripUtf8Bom(raw));
  } catch (err) {
    return {
      manifestPath,
      origin: locationOrigin ?? "user",
      originSource: locationOrigin ? "location" : "declared-scope",
      valid: false,
      pluginId: null,
      errors: [
        { path: "(root)", message: formatErrorMessage(err, "plugin.json is not valid JSON") },
      ],
      warnings: [],
    };
  }

  const declaredScope = (json as { scope?: unknown } | null)?.scope;
  const origin: PluginOrigin = locationOrigin ?? (declaredScope === "project" ? "project" : "user");
  const originSource: PluginManifestValidationResult["originSource"] = locationOrigin
    ? "location"
    : "declared-scope";

  const parsed = getPluginManifestSchema(origin).safeParse(json);
  const rawName = (json as { name?: unknown } | null)?.name;
  const pluginId = typeof rawName === "string" && rawName.length > 0 ? rawName : null;

  if (!parsed.success) {
    const errors: PluginManifestIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    }));
    return { manifestPath, origin, originSource, valid: false, pluginId, errors, warnings: [] };
  }

  const iconErrors = await collectPluginIconIssues(parsed.data.name, dir, parsed.data.contributes);
  return {
    manifestPath,
    origin,
    originSource,
    valid: iconErrors.length === 0,
    pluginId: parsed.data.name,
    errors: iconErrors,
    warnings: await collectManifestAdvisories({ dir, rawJson: json, manifest: parsed.data }),
  };
}

// ── Plugin diagnostics snapshot ───────────────────────────────────────────

export async function handleGetDiagnosticsSnapshot(): Promise<PluginDiagnosticsSnapshot> {
  // Block until startup activation settles so the snapshot is post-activation
  // (mirrors handleToolbarButtons) — otherwise a fast renderer could read an
  // empty plugin set before any activate() runs.
  const pluginService = await getPluginService();
  await pluginService.waitForInit();
  return pluginService.getDiagnosticsSnapshot();
}

/**
 * "Back up data…" from a plugin panel's menus. The renderer names only the
 * plugin: which databases exist, where they live and what they are called all
 * come from main's own copy of the manifest and binding. A project plugin
 * answers only to its own project's renderers, as `plugin:invoke` does.
 */
export async function handleBackupDatabases(
  ctx: IpcContext,
  pluginId: string
): Promise<PluginDataBackupOutcome> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("backupDatabases: pluginId must be a plugin instance id");
  }
  const boundProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (boundProjectId !== null && boundProjectId !== ctx.projectId) {
    throw new Error("backupDatabases rejected: plugin belongs to a different project");
  }
  const source = (await getPluginService()).getDataBackupSource(pluginId);
  if (!source) throw new Error(`Plugin "${pluginId}" isn't running`);

  const { backupPluginData } = await import("../../../services/plugin/pluginDataBackup.js");
  const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
  const title = `Back up ${source.displayName} data`;
  return backupPluginData(
    source,
    {
      chooseFile: async (defaultPath) => {
        const options = {
          title,
          defaultPath,
          filters: [{ name: "SQLite database", extensions: ["db"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"] as Array<
            "createDirectory" | "showOverwriteConfirmation"
          >,
        };
        const result = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      chooseFolder: async (defaultPath) => {
        const options = {
          title,
          defaultPath,
          buttonLabel: "Back up here",
          properties: ["openDirectory", "createDirectory"] as Array<
            "openDirectory" | "createDirectory"
          >,
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
      },
    },
    { downloadsDir: app.getPath("downloads") }
  );
}
