import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PluginSettingsFocusRequest } from "@/components/Settings/PluginSettingsForm";
import { pluginHasSettings } from "@/services/plugin/pluginSettingsHome";
import { useProjectPluginStore, type ProjectPluginErrorSource } from "@/store/projectPluginStore";
import { cn } from "@/lib/utils";
import type { LoadedPluginInfo, ProjectPluginInfo, ProjectPluginState } from "@shared/types/plugin";

/**
 * The word beside a project plugin's name.
 *
 * `blocked` reads as "Off" because that is what it means to the person looking
 * at it — the plugin is not running — and the pane below says *why*, which is
 * where the distinction between "the folder is off" and "this one is off"
 * actually matters.
 */
const STATE_LABEL: Record<ProjectPluginState, string> = {
  active: "Running",
  staged: "Staged",
  blocked: "Off",
  invalid: "Invalid",
};

/**
 * One status for the picker, the badge and the pane. A plugin in a folder that is
 * turned off is off whatever its own state says, so the folder decides first.
 */
export function projectPluginStatus(plugin: ProjectPluginInfo, folderTrusted: boolean): string {
  if (plugin.state === "invalid") return STATE_LABEL.invalid;
  if (plugin.muted || !folderTrusted) return "Off";
  return STATE_LABEL[plugin.state];
}

/**
 * A failed write, stated on the row whose control made it: what didn't happen,
 * the reason main gave, and the same write again. `SettingsRow` supplies the
 * error glyph and keeps the words on the neutral ramp.
 */
export function RowFailure({
  summary,
  detail,
  onRetry,
}: {
  summary: string;
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    // The recovery sits under the words rather than beside them, so the glyph
    // stays on the first line and a long reason from main never squeezes it.
    <span role="alert" className="flex flex-col items-start gap-2">
      <span className="min-w-0 break-words">
        {summary}
        {detail && <span className="text-text-secondary"> — {detail}</span>}
      </span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </span>
  );
}

type FailureOf<A extends ProjectPluginErrorSource["action"]> = Extract<
  ProjectPluginErrorSource,
  { action: A }
>;

function isFailureOf<A extends ProjectPluginErrorSource["action"]>(
  source: ProjectPluginErrorSource,
  action: A
): source is FailureOf<A> {
  return source.action === action;
}

/**
 * The store's last failure when it came from `action` — and, for a per-plugin
 * action, from this plugin — so each row answers only for its own writes.
 */
export function useStoreFailure<A extends ProjectPluginErrorSource["action"]>(
  action: A,
  pluginId?: string
): { source: FailureOf<A>; detail: string | null } | null {
  const error = useProjectPluginStore((s) => s.error);
  const source = useProjectPluginStore((s) => s.errorSource);
  if (error === null || source === null || !isFailureOf(source, action)) return null;
  if (pluginId !== undefined && "pluginId" in source && source.pluginId !== pluginId) return null;
  return { source, detail: source.reason };
}

/** Whether a project plugin runs now, by its live state rather than the loaded list. */
export function isProjectPluginRunning(plugin: ProjectPluginInfo, folderTrusted: boolean): boolean {
  return folderTrusted && !plugin.muted && plugin.state === "active";
}

/** Whether a loaded plugin contributes settings, so its section is worth a heading. */
export function hasPluginSettings(
  plugin: LoadedPluginInfo | undefined
): plugin is LoadedPluginInfo {
  return plugin !== undefined && pluginHasSettings(plugin);
}

/** The DOM id of a plugin pane's Settings section, where a key-less deep link lands. */
export const PLUGIN_SETTINGS_HOME_ID = "project-plugin-settings-home";

/** A settings deep link aimed at the pane showing it, and how to report it handled. */
export interface PaneSettingsFocus {
  request: PluginSettingsFocusRequest | null;
  onHandled: (nonce: number) => void;
}

/** Longer than this and a manifest description is clamped behind "Show more". */
const LONG_DESCRIPTION = 160;

/**
 * The plugin's name as the section title, its manifest description and id beneath.
 * The id stays visible because two plugins can share a display name, and the
 * `collidesWithGlobal` case is exactly two plugins sharing an id — unless the
 * title already is the id, as it is for a manifest that couldn't be read.
 */
export function PluginIdentityDescription({
  description,
  id,
  title,
}: {
  description?: string;
  id: string;
  title: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const long = (description?.length ?? 0) > LONG_DESCRIPTION;
  return (
    <>
      {description && (
        <span id={textId} className={cn("block break-words", long && !expanded && "line-clamp-2")}>
          {description}
        </span>
      )}
      {long && (
        <Button
          variant="link"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
      {id !== title && <span className="mt-1 block font-mono break-all">{id}</span>}
    </>
  );
}

/**
 * Whether a per-project package is on in this project: the store's answer, which
 * holds an in-flight toggle's value, or the list's own record until it has one.
 */
export function isInstanceOn(
  plugin: LoadedPluginInfo,
  instanceEnabled: Readonly<Record<string, boolean>>,
  projectId: string | null
): boolean {
  return (
    instanceEnabled[plugin.instanceId] ??
    (projectId !== null && (plugin.enabledInProjects ?? []).includes(projectId))
  );
}
