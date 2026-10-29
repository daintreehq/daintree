// The plugin actions' run bodies, loaded on first dispatch by `runPluginAction`
// in pluginActions.ts, which keeps the metadata every view registers at boot
// (#14275). Nothing here may import pluginActions.ts at runtime.
import type { ActionCallbacks } from "../actionTypes";
import type { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { pluginClient } from "@/clients/pluginClient";
import { parseProjectPluginInstanceKey } from "@shared/types/plugin";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import {
  hasViewUnsavedChanges,
  requestUserViewReload,
} from "@/services/plugin/pluginPanelLifecycle";
import { usePanelStore } from "@/store/panelStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectStore } from "@/store/projectStore";
import { resolvePluginSettingsTarget } from "@/services/plugin/pluginSettingsHome";
import { usePluginPanelReloadConfirmStore } from "@/store/pluginPanelReloadConfirmStore";
import { isBuiltInPanelKind } from "@shared/types/panel";
import { getPanelKindConfig, panelKindHasPty } from "@shared/config/panelKindRegistry";
import {
  PanelCaptureRefusedError,
  assertPanelCapturable,
  consoleMessagesForPlugin,
  locatePanelFrame,
  sameRect,
} from "@/services/plugin/pluginPanelCapture";
import { ConfirmationStagedError, confirmationStagedMessage } from "../confirmationStaged";
import { UnactionableTargetError } from "../unactionableTarget";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { pluginSilenceScope } from "@/lib/notificationSourceLabel";
import { systemClient } from "@/clients/systemClient";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  BackupDatabasesArgsSchema,
  CapturePanelArgsSchema,
  DiagnosticsArgsSchema,
  OpenSettingsArgsSchema,
  ReloadPanelArgsSchema,
  SetNotificationsSilencedArgsSchema,
  ValidateArgsSchema,
} from "./pluginActionArgs";
import { DIAGNOSTICS_LOG_LIMIT_DEFAULT } from "./pluginDiagnosticsLimits";

/** The folder part of a path main returned, kept in the platform's own separators. */
function dirnameOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/**
 * Read an action's validated args as its schema's output type.
 *
 * `run` receives `unknown`, but ActionService has already parsed `argsSchema`
 * and hands over the parsed value, so the schema named here — the same one
 * pluginActions.ts registers — is the type the args actually have. The cast is
 * written once here rather than at each body, and takes the schema as a type so
 * this chunk never imports the args schemas at runtime.
 */
function argsOf<S extends z.ZodType>(args: unknown): z.output<S> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionService validated `argsSchema` before run()
  return args as z.output<S>;
}

export const pluginActionRuns = {
  "plugin.reloadWindow": async (_args: unknown, ctx: ActionContext) => {
    // An MCP caller has already cleared the host confirmation; a second
    // dialog would let a cancel return ok:true with nothing reloaded.
    if (ctx?.hostConfirmed === true || (await pluginDocumentRuntime.requestReloadConfirmation())) {
      await window.electron.window.reload();
    }
  },
  "plugin.reloadPanel": async (args: unknown) => {
    const { panelId } = argsOf<typeof ReloadPanelArgsSchema>(args);
    const confirm = usePluginPanelReloadConfirmStore.getState();
    const approved = confirm.consumeApproval(panelId);
    const panel = usePanelStore.getState().panelsById[panelId];
    if (!panel) throw new Error(`No panel with id "${panelId}"`);
    const kind = panel.kind ?? "terminal";
    if (isBuiltInPanelKind(kind) || panelKindHasPty(kind)) {
      throw new Error(`Panel "${panelId}" is not a plugin panel`);
    }
    if (!approved && hasViewUnsavedChanges(panelId)) {
      // A blank title would read "Reload ''?"; the kind's name is what the
      // panel's header falls back to as well.
      const panelTitle = panel.title.trim() || getPanelKindConfig(kind)?.name.trim() || "";
      if (!confirm.request({ panelId, panelTitle })) {
        throw new Error(
          "Reloading this panel was not performed — another panel's reload is waiting for the user to confirm it. Nothing changed; try again once that one is answered."
        );
      }
      throw new ConfirmationStagedError(confirmationStagedMessage("Reloading this panel"));
    }
    const outcome: "scheduled" | "not-mounted" = requestUserViewReload(panelId)
      ? "scheduled"
      : "not-mounted";
    return { panelId, outcome };
  },
  "plugin.capturePanel": async (args: unknown) => {
    const { panelId } = argsOf<typeof CapturePanelArgsSchema>(args);
    const panel = usePanelStore.getState().panelsById[panelId];
    // Refusals of the target itself: a retry with the same id cannot work.
    if (!panel) throw new UnactionableTargetError(`No panel with id "${panelId}"`);
    const kind = panel.kind ?? "terminal";
    const pluginId = getPanelKindConfig(kind)?.extensionId;
    if (isBuiltInPanelKind(kind) || panelKindHasPty(kind) || !pluginId) {
      throw new UnactionableTargetError(`Panel "${panelId}" is not a plugin panel`);
    }
    const capture = window.electron?.plugin?.capturePanel;
    if (!capture) throw new Error("Panel capture isn't available in this window");

    const frame = locatePanelFrame(panelId);
    const rect = assertPanelCapturable(panelId, frame, panel.location);
    const shot = await capture(rect);
    // Anything that opened, moved or closed while the pixels were taken
    // may be in them; those bytes are dropped rather than returned. The
    // record itself is replaced whenever the view persists state, so only
    // what decides where and what the panel shows is compared.
    const current = usePanelStore.getState().panelsById[panelId];
    if (
      !current ||
      current.kind !== panel.kind ||
      current.location !== panel.location ||
      locatePanelFrame(panelId) !== frame ||
      !sameRect(rect, assertPanelCapturable(panelId, frame, current.location))
    ) {
      throw new PanelCaptureRefusedError(`Panel "${panelId}" changed while it was captured; retry`);
    }

    const { messages, omitted } = consoleMessagesForPlugin(shot.consoleMessages, pluginId);
    return {
      panelId,
      pluginId,
      image: {
        mimeType: "image/png" as const,
        data: shot.pngBase64,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      consoleScope: "plugin" as const,
      consoleMessages: messages,
      consoleOmitted: omitted,
    };
  },
  "plugin.validate": async (args: unknown) =>
    pluginClient.validateManifest(argsOf<typeof ValidateArgsSchema>(args).path),
  "plugin.diagnostics": async (rawArgs: unknown, ctx: ActionContext) => {
    const args = argsOf<typeof DiagnosticsArgsSchema>(rawArgs);
    const limit = args.logLimit ?? DIAGNOSTICS_LOG_LIMIT_DEFAULT;
    const snapshot = await pluginClient.getDiagnosticsSnapshot();

    // A project plugin runs under an instance key
    // (`project__{projectId}__{publisher.name}`), never its bare manifest
    // id — but the manifest id is the only one its author knows, because it
    // is the one they wrote. Parse the key rather than matching its tail: a
    // suffix test also matches the SAME id owned by a different open
    // project, and the snapshot is app-global, so it would hand this
    // project's agent another project's log lines.
    const matches = (candidate: string): boolean => {
      if (candidate === args.pluginId) return true;
      const parsed = parseProjectPluginInstanceKey(candidate);
      if (!parsed || parsed.manifestId !== args.pluginId) return false;
      // Only this caller's own project. Without a project on the sender
      // there is no owner to compare against, so no instance key qualifies.
      return ctx.projectId !== undefined && parsed.projectId === ctx.projectId;
    };
    const entry = snapshot.plugins.find((p) => matches(p.pluginId));

    if (entry) {
      // Rebuilt field by field rather than spread: the snapshot entry also
      // carries install provenance and the action audit trail, neither of
      // which belongs in an authoring diagnostic.
      return {
        // The id the caller asked with, not the instance key it happens to
        // run under — the key names a project and is not theirs to hold.
        pluginId: args.pluginId,
        displayName: entry.displayName,
        version: entry.version,
        loaded: true,
        disabled: entry.disabled,
        devMode: entry.devMode,
        projectState: null,
        loadError: entry.loadError
          ? {
              message: entry.loadError.message,
              stack: entry.loadError.stack ?? null,
              at: entry.loadError.at ?? null,
            }
          : null,
        logLines: entry.logLines.slice(-limit).map((line) => ({
          ts: line.ts,
          level: line.level,
          message: line.message,
        })),
        logLinesAvailable: entry.logLines.length,
      };
    }

    // The snapshot only covers plugins the host is running, and the case an
    // author hits most is the one it therefore omits: a manifest the
    // project refused. Fall back to the project's own list so a rejected
    // plugin reports its rejection instead of reading as nonexistent.
    const projectPlugins = await pluginClient.getProjectPlugins();
    const projectEntry = projectPlugins.find(
      (p) => p.id === args.pluginId || p.dirName === args.pluginId
    );
    if (projectEntry) {
      return {
        pluginId: projectEntry.id,
        displayName: projectEntry.displayName,
        version: projectEntry.version,
        loaded: false,
        disabled: false,
        devMode: false,
        projectState: projectEntry.state,
        loadError: projectEntry.error
          ? { message: projectEntry.error, stack: null, at: null }
          : null,
        logLines: [],
        logLinesAvailable: 0,
      };
    }

    // Reported as manifest ids: an instance key names a project the caller
    // may not own, and is not a value they could pass back here anyway.
    const known = [
      ...snapshot.plugins.map(
        (p) => parseProjectPluginInstanceKey(p.pluginId)?.manifestId ?? p.pluginId
      ),
      ...projectPlugins.map((p) => p.id),
    ]
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();
    throw new Error(
      known.length > 0
        ? `No plugin "${args.pluginId}". Known ids: ${known.join(", ")}`
        : `No plugin "${args.pluginId}", and no plugins are loaded or discovered in this project.`
    );
  },
  "plugin.openSettings": async (args: unknown, ctx: ActionContext, callbacks: ActionCallbacks) => {
    const { pluginId, key, section, page, scope } = argsOf<typeof OpenSettingsArgsSchema>(args);
    const projectId = ctx?.projectId ?? useProjectStore.getState().currentProject?.id ?? null;
    const resolution = resolvePluginSettingsTarget(
      pluginId,
      key,
      await pluginClient.list(),
      projectId,
      {
        ...(section !== undefined ? { section } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(scope !== undefined ? { scope } : {}),
      }
    );
    if (!resolution.ok) {
      throw new Error(
        {
          "not-found": `No plugin "${pluginId}" is loaded here`,
          ambiguous: `"${pluginId}" names more than one plugin here — pass its instance key`,
          "no-settings": `Plugin "${pluginId}" has no settings`,
          "needs-project": `Plugin "${pluginId}" keeps ${key === undefined ? "its settings" : `"${key}"`} in Project settings, and no project is open`,
        }[resolution.reason]
      );
    }
    const { target } = resolution;
    usePluginManagerStore.getState().requestSettings({
      pluginId: target.plugin.instanceId,
      home: target.home,
      ...(target.key !== undefined ? { key: target.key } : {}),
      ...(target.section !== undefined ? { section: target.section } : {}),
      ...(target.page !== undefined ? { page: target.page } : {}),
    });
    if (target.home === "project") callbacks.onOpenSettingsTab({ tab: "project:plugins" });
    return {
      pluginId,
      home: target.home === "project" ? "project-settings" : "plugin-manager",
      requestedKey: target.key ?? null,
      requestedSection: target.section ?? null,
    };
  },
  "plugin.backupDatabases": async (args: unknown) => {
    const { pluginId } = argsOf<typeof BackupDatabasesArgsSchema>(args);
    const retry = () =>
      void actionService.dispatch("plugin.backupDatabases", { pluginId }, { source: "user" });
    let outcome;
    try {
      outcome = await pluginClient.backupDatabases(pluginId);
    } catch (error) {
      notify({
        type: "error",
        priority: "high",
        title: "Couldn't back up plugin data",
        message: formatErrorMessage(error, "The backup stopped before any file was written."),
        action: { label: "Try again", onClick: retry },
      });
      throw error;
    }
    if (outcome.status === "cancelled") return outcome;
    if (outcome.status === "no-data") {
      notify({
        type: "info",
        priority: "high",
        transient: true,
        duration: 4000,
        message: `${outcome.pluginName} has no data to back up yet`,
      });
      return outcome;
    }
    const [first] = outcome.paths;
    const reveal = revealCopy();
    notify({
      type: "success",
      priority: "high",
      title: `${outcome.pluginName} data backed up`,
      message:
        outcome.paths.length === 1
          ? `Saved to ${first}`
          : `${outcome.paths.length} databases saved to ${dirnameOf(first!)}`,
      ...(first !== undefined
        ? {
            action: {
              label: reveal.label,
              onClick: () => void systemClient.showItemInFolderUnconfined(first),
            },
          }
        : {}),
    });
    return outcome;
  },
  "plugin.setNotificationsSilenced": async (args: unknown) => {
    const { pluginId, silenced } = argsOf<typeof SetNotificationsSilencedArgsSchema>(args);
    const retry = () =>
      void actionService.dispatch(
        "plugin.setNotificationsSilenced",
        { pluginId, silenced },
        { source: "user" }
      );
    let silences;
    try {
      silences = await pluginClient.setNotificationSilenced(pluginId, silenced);
    } catch (error) {
      notify({
        type: "error",
        priority: "high",
        title: silenced ? "Couldn't silence plugin" : "Couldn't unsilence plugin",
        message: formatErrorMessage(error, "The setting wasn't saved."),
        context: { eventKind: "settings" },
        action: { label: "Try again", onClick: retry },
      });
      throw error;
    }
    if (!silenced) return;
    const silence = silences.find((entry) => entry.pluginId === pluginId);
    const name = silence?.name ?? parseProjectPluginInstanceKey(pluginId)?.manifestId ?? pluginId;
    const projectId = silence?.projectId ?? null;
    const projectName = projectId
      ? useProjectStore.getState().projects.find((p) => p.id === projectId)?.name
      : undefined;
    notify({
      type: "success",
      message: `Silenced ${name}${pluginSilenceScope(projectId, projectName)}`,
      priority: "high",
      duration: UNDO_TOAST_DURATION_MS,
      context: { eventKind: "settings" },
      // One-shot Undo confirmation; Settings → Notifications lists every
      // silenced plugin, so the inbox needs no row for it.
      transient: true,
      action: {
        label: "Undo",
        // Through the action, so a failed Undo says so and offers Try again.
        onClick: () =>
          void actionService.dispatch(
            "plugin.setNotificationsSilenced",
            { pluginId, silenced: false },
            { source: "user" }
          ),
      },
    });
  },
  "plugin.reloadProject": async () => {
    await pluginClient.reloadProjectPlugins();
    const plugins = await pluginClient.getProjectPlugins();
    return {
      plugins: plugins.map((p) => ({
        id: p.id,
        dirName: p.dirName,
        displayName: p.displayName,
        version: p.version,
        state: p.state,
        error: p.error ?? null,
        collidesWithGlobal: p.collidesWithGlobal,
      })),
    };
  },
} satisfies Record<
  string,
  (args: unknown, ctx: ActionContext, callbacks: ActionCallbacks) => Promise<unknown>
>;

export type PluginActionRunId = keyof typeof pluginActionRuns;
