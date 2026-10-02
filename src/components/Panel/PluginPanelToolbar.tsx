import { useId, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEFAULT_PLUGIN_BUTTON_ICON,
  resolvePluginIcon,
} from "@/components/icons/pluginIconRegistry";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { actionService } from "@/services/ActionService";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
  type PanelKindConfig,
  type PluginPanelToolbarItemConfig,
} from "@shared/config/panelKindRegistry";
import {
  usePanelToolbarStates,
  type PluginPanelToolbarItemLiveState,
} from "@/store/pluginPanelToolbarStore";
import type { ActionId } from "@shared/types/actions";

/** A declared toolbar entry whose action is registered, with its label resolved. */
export interface PluginPanelToolbarButton extends PluginPanelToolbarItemConfig {
  label: string;
}

const NO_BUTTONS: readonly PluginPanelToolbarButton[] = [];

/**
 * The kind's toolbar entries that can be drawn right now, in declared order.
 * An entry waits until its action registers, exactly as a menu entry does, and
 * takes the action's title when the manifest gives no label.
 */
export function resolvePluginToolbarButtons(
  config: PanelKindConfig | undefined,
  registeredActions: ReadonlyMap<string, string>
): readonly PluginPanelToolbarButton[] {
  const declared = config?.pluginToolbar;
  if (!declared || declared.length === 0) return NO_BUTTONS;
  return declared.flatMap((item) => {
    const title = registeredActions.get(item.actionId);
    if (title === undefined) return [];
    const label = item.label ?? title;
    return label.length > 0 ? [{ ...item, label }] : [];
  });
}

type StatusTone = "warning" | "danger";

const TONE_VISUAL: Record<StatusTone, (typeof SEVERITY_VISUAL)["warning"]> = {
  warning: SEVERITY_VISUAL.warning,
  danger: SEVERITY_VISUAL.error,
};

const TONE_SPOKEN: Record<StatusTone | "stale", string> = {
  warning: "Warning:",
  danger: "Error:",
  stale: "Out of date:",
};

interface PluginPanelToolbarProps {
  panelId: string;
  kind: string;
  /** Off where the header's own controls skip roving (the dock). */
  rovingEnabled?: boolean;
}

/**
 * A plugin panel's manifest `toolbar`, drawn in its header ahead of the window
 * controls. One tab stop with arrows inside, like those controls. Reads the
 * registry and the registered actions from their subscribed snapshots, so a
 * plugin reloading its manifest or registering an action late reaches the
 * header without a remount.
 */
export function PluginPanelToolbar({
  panelId,
  kind,
  rovingEnabled = true,
}: PluginPanelToolbarProps) {
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const registeredActions = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );
  const config = registry[kind];
  const buttons = resolvePluginToolbarButtons(config, registeredActions);
  if (buttons.length === 0) return null;
  return (
    <PluginPanelToolbarRow
      panelId={panelId}
      name={config?.name ?? "Plugin"}
      buttons={buttons}
      rovingEnabled={rovingEnabled}
    />
  );
}

/**
 * Mounted only while there is a button to draw, so the roving hook's focus
 * listener attaches to a row that exists rather than to the `null` an empty
 * toolbar renders — a late-registering action would otherwise leave it unwired.
 */
function PluginPanelToolbarRow({
  panelId,
  name,
  buttons,
  rovingEnabled,
}: {
  panelId: string;
  name: string;
  buttons: readonly PluginPanelToolbarButton[];
  rovingEnabled: boolean;
}) {
  const states = usePanelToolbarStates(panelId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleKeyDown = useToolbarRoving(rootRef, rovingEnabled);
  return (
    // Shrinks rather than pushing the window controls out of the clipped
    // header: labels and statuses truncate first.
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={`${name} actions`}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      data-testid="panel-header-plugin-toolbar"
      className="ml-1.5 flex min-w-0 shrink items-center gap-1"
    >
      {buttons.map((button) => (
        <PluginPanelToolbarItem
          key={button.actionId}
          panelId={panelId}
          button={button}
          state={states[button.stateKey]}
        />
      ))}
    </div>
  );
}

interface PluginPanelToolbarItemProps {
  panelId: string;
  button: PluginPanelToolbarButton;
  state: PluginPanelToolbarItemLiveState | undefined;
}

function PluginPanelToolbarItem({ panelId, button, state }: PluginPanelToolbarItemProps) {
  const statusId = useId();
  const busy = state?.busy === true;
  const disabled = state?.disabled === true;
  const tooltip = state?.tooltip ?? button.label;
  const showsStatus =
    button.status === true &&
    state !== undefined &&
    (state.text !== undefined || state.updatedAt !== undefined || isToned(state.tone));
  const Icon = button.iconId ? resolvePluginIcon(button.iconId, DEFAULT_PLUGIN_BUTTON_ICON) : null;
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // Announced unavailable rather than natively disabled, so focus stays on
    // the button and the veto has to happen here.
    if (busy || disabled) return;
    void actionService.dispatch(button.actionId as ActionId, { panelId }, { source: "user" });
  };
  const control = (
    <Button
      variant="ghost"
      size={Icon ? "icon-xs" : "xs"}
      loading={busy}
      aria-disabled={disabled || undefined}
      aria-label={Icon ? button.label : undefined}
      aria-describedby={showsStatus ? statusId : undefined}
      onClick={handleClick}
      onPointerDown={(event) => event.stopPropagation()}
      data-plugin-action={button.actionId}
      className={cn(
        Icon ? "shrink-0 [&_svg]:size-3.5" : "min-w-0 max-w-[160px] shrink",
        disabled && !busy && ARIA_DISABLED_CLASSES
      )}
    >
      {Icon ? <Icon aria-hidden="true" /> : <span className="truncate">{button.label}</span>}
    </Button>
  );
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      {showsStatus && state ? <PluginPanelToolbarStatus id={statusId} state={state} /> : null}
      {/* Always the same tree, so a tooltip arriving or leaving never remounts
          the button out from under keyboard focus; a cut-off label reads in full
          on hover. */}
      <Tooltip>
        <TooltipTrigger asChild>{control}</TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function isToned(tone: PluginPanelToolbarItemLiveState["tone"]): tone is StatusTone {
  return tone === "warning" || tone === "danger";
}

/**
 * The status beside a `status: true` button: the view's text, then the age of
 * its `updatedAt` on the host's shared minute clock. Colour is never the only
 * signal, so a toned status always carries its glyph and a spoken prefix; the
 * text stays on the readable ramp and only the glyph takes the status colour.
 */
function PluginPanelToolbarStatus({
  id,
  state,
}: {
  id: string;
  state: PluginPanelToolbarItemLiveState;
}) {
  const now = useGlobalMinuteClock();
  const { updatedAt, staleAfterMs } = state;
  const stale =
    updatedAt !== undefined && staleAfterMs !== undefined && now - updatedAt > staleAfterMs;
  // An explicit tone, "default" included, outranks the age's own warning.
  const tone: StatusTone | null =
    state.tone !== undefined ? (isToned(state.tone) ? state.tone : null) : stale ? "warning" : null;
  const visual = tone ? TONE_VISUAL[tone] : null;
  const ToneIcon = visual?.Icon;
  const spoken = tone ? TONE_SPOKEN[state.tone === undefined ? "stale" : tone] : null;
  return (
    <span
      id={id}
      data-status-tone={tone ?? "default"}
      className={cn(
        "flex min-w-0 shrink items-center gap-1 text-xs",
        tone ? "text-text-primary" : "text-text-secondary"
      )}
    >
      {ToneIcon && visual ? (
        <ToneIcon aria-hidden="true" className={cn("h-3 w-3 shrink-0", visual.toneClass)} />
      ) : null}
      {spoken ? <span className="sr-only">{spoken}</span> : null}
      {/* Yields first on a narrow header: the glyph keeps the warning visible. */}
      <span className="min-w-0 max-w-[160px] truncate @max-[420px]/header:sr-only">
        {state.text}
        {state.text !== undefined && updatedAt !== undefined ? " · " : null}
        {updatedAt !== undefined ? (
          <TimeAgo timestamp={updatedAt} now={now} prefix="Updated " />
        ) : null}
      </span>
    </span>
  );
}
