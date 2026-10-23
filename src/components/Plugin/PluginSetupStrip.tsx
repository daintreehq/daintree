import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import {
  pluginManifestIdFromInstanceKey,
  type PluginRequiredSettingsStatus,
} from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { usePluginSetupStatus, type PluginSetupState } from "@/hooks/usePluginSetupStatus";
import { getVisibleTabbableElements, restoreFocusTo } from "@/lib/accessibility";
import { actionService } from "@/services/ActionService";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { PluginSetupChecklist } from "./PluginSetupChecklist";

/**
 * "<Plugin> needs setup", above a plugin surface whose plugin declares a
 * `required` setting that is still unset.
 *
 * It sits ABOVE the content, in flow, never inside the plugin's box — the same
 * placement the project surface strip uses, and for the same reason: plugins
 * draw their own toolbars along the top edge, and a host control floated into
 * that region gets painted over or pushes the plugin's own layout around. Every
 * plugin surface gets it: a view panel, a PTY-backed panel and a project
 * surface all draw it the same way.
 *
 * Neutral on purpose. A missing credential is a standing state the user can
 * see and fix, not a failure, and the surface is usually still useful to look
 * at — so no warning wash and no accent, just the one way forward. It goes away
 * by itself: main announces every settings write, and the strip re-reads which
 * required keys are still missing whenever it does.
 *
 * Only ids and labels cross the bridge, never a value. A required key whose
 * stored file couldn't be read is said as what it is — "Couldn't read <label>"
 * — rather than as missing, which would be a guess, or as nothing, which would
 * leave the panel silent while `host.settings.missingRequired()` tells the
 * plugin the same key is unusable. An unset key takes precedence: the setup
 * prompt is the one the user can act on directly.
 *
 * A plugin that declares a `contributes.setup` checklist (#13824) gets one
 * strip for it instead — "<Plugin> setup · 2 of 3" — while any step is neither
 * done nor skipped, and the steps open in a popover from it. Once every step is
 * handled, the required-settings prompt above takes over again, so a required
 * key the checklist doesn't cover is still asked for.
 */
export function PluginSetupStrip({ pluginId }: { pluginId: string }) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const displayName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);
  const [status, setStatus] = useState<PluginRequiredSettingsStatus>(EMPTY_STATUS);
  const setup = usePluginSetupStatus(pluginId, projectId);
  // The popover belongs to one plugin's checklist in one project: a switch to
  // another, or a checklist that goes away, never reopens it on its own.
  const checklistKey = setup.total > 0 ? `${pluginId}\u0000${projectId ?? ""}` : null;
  const [popover, setPopover] = useState<ChecklistPopoverState>(CLOSED_POPOVER);
  const ownPopover =
    popover.key !== null && popover.key === checklistKey ? popover : CLOSED_POPOVER;
  useEffect(() => {
    setPopover((current) => (current.key === checklistKey ? current : CLOSED_POPOVER));
  }, [checklistKey]);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getRequiredSettingsStatus !== "function") return;
    let cancelled = false;
    // Sequenced so a slow read can never overwrite a newer one.
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      bridge
        .getRequiredSettingsStatus(pluginId, projectId)
        .then((next) => {
          if (!cancelled && current === generation) setStatus(next);
        })
        .catch((err: unknown) => {
          // A refused request (a foreign project, a malformed id) says nothing
          // about the settings themselves, so it shows nothing.
          if (!cancelled && current === generation) setStatus(EMPTY_STATUS);
          logError(`Failed to read required settings for ${pluginId}`, err);
        });
    };
    refresh();
    const unsubscribe = bridge.onSettingsChanged?.((payload) => {
      if (payload.pluginId === pluginId) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [pluginId, projectId]);

  // Waiting on the checklist read keeps a plugin with both from showing the
  // required prompt for a moment and then swapping it out.
  if (!setup.loaded) return null;
  // Held from the popover opening until its close has put focus back on the
  // trigger, even once every step is handled: the popover shows the finished
  // list meanwhile. When the strip then goes, focus moves to whatever now
  // leads its container — the required prompt's action, or the surface —
  // instead of falling to <body> with the trigger.
  if (checklistKey !== null && (setup.handled < setup.total || ownPopover.held)) {
    return (
      <PluginSetupChecklistStrip
        stripRef={stripRef}
        pluginId={pluginId}
        displayName={displayName}
        setup={setup}
        canSkip={projectId !== null}
        open={ownPopover.open}
        onOpenChange={(open) =>
          setPopover((current) => ({
            key: checklistKey,
            open,
            held: open || (current.key === checklistKey && current.held),
          }))
        }
        onCloseSettled={() => {
          const strip = stripRef.current;
          const home = strip?.parentElement ?? null;
          const focusWasHere = strip?.contains(document.activeElement) === true;
          setPopover((current) => ({ ...current, held: false }));
          if (!focusWasHere || !home) return;
          requestAnimationFrame(() => {
            if (document.activeElement && document.activeElement !== document.body) return;
            restoreFocusTo(getVisibleTabbableElements(home)[0]);
          });
        }}
      />
    );
  }

  const firstMissing = status.missing[0];
  const firstUnreadable = status.unreadable[0];
  const target = firstMissing ?? firstUnreadable;
  if (target === undefined) return null;

  const title =
    firstMissing !== undefined
      ? `${displayName} needs setup`
      : status.unreadable.length === 1
        ? `Couldn't read ${status.labels[target] ?? target}`
        : `Couldn't read ${status.unreadable.length} of ${displayName}'s settings`;

  return (
    <div className="shrink-0" data-testid="plugin-setup-strip">
      <InlineStatusBanner
        title={title}
        severity={firstMissing !== undefined ? "neutral" : "warning"}
        role="status"
        layout="inline"
        action={{
          id: "configure",
          label: "Open plugin settings",
          variant: "primary",
          onClick: () => {
            void actionService.dispatch(
              "plugin.openSettings",
              { pluginId, key: target },
              { source: "user" }
            );
          },
        }}
      />
    </div>
  );
}

const EMPTY_STATUS: PluginRequiredSettingsStatus = { missing: [], unreadable: [], labels: {} };

interface ChecklistPopoverState {
  key: string | null;
  open: boolean;
  /** Keeps the strip mounted until the popover's close has restored focus. */
  held: boolean;
}

const CLOSED_POPOVER: ChecklistPopoverState = { key: null, open: false, held: false };

function PluginSetupChecklistStrip({
  stripRef,
  pluginId,
  displayName,
  setup,
  canSkip,
  open,
  onOpenChange,
  onCloseSettled,
}: {
  stripRef: RefObject<HTMLDivElement | null>;
  pluginId: string;
  displayName: string;
  setup: PluginSetupState;
  canSkip: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a close has restored focus, which happens once the content is gone. */
  onCloseSettled: () => void;
}) {
  const headingId = useId();
  const progress = `${setup.handled} of ${setup.total}`;
  return (
    <div ref={stripRef} className="shrink-0" data-testid="plugin-setup-strip">
      <InlineStatusBanner
        title={`${displayName} setup · ${progress}`}
        severity="neutral"
        role="status"
        layout="inline"
        trailingSlot={
          <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                className="shadow-none inset-shadow-none aria-expanded:bg-overlay-hover"
                data-notification-action="primary"
              >
                Setup steps
              </Button>
            </PopoverTrigger>
            <PopoverContent
              // A short window gets the space there is, and the rows scroll.
              className="flex max-h-[var(--radix-popover-content-available-height)] w-96 flex-col p-0"
              aria-labelledby={headingId}
              // Radix restores focus to the trigger after this returns, so the
              // strip lets go a frame later.
              onCloseAutoFocus={() => requestAnimationFrame(onCloseSettled)}
            >
              <div className={cn(POPOVER_HEADER_CLASS, "shrink-0")}>
                <span id={headingId} className={POPOVER_TITLE_CLASS}>
                  {displayName} setup
                </span>
                <span className={POPOVER_HEADER_META_CLASS}>{progress}</span>
              </div>
              <ScrollShadow compact className="max-h-96 flex-1">
                <PluginSetupChecklist
                  pluginId={pluginId}
                  rows={setup.rows}
                  canSkip={canSkip}
                  onSetSkipped={setup.setSkipped}
                  saveErrorStepId={setup.saveErrorStepId}
                  variant="plain"
                  onAction={() => onOpenChange(false)}
                />
              </ScrollShadow>
            </PopoverContent>
          </Popover>
        }
      />
    </div>
  );
}

/**
 * The strip for a surface identified by its panel kind — a PTY-backed plugin
 * panel or a project surface — read reactively off the kind registry, so a
 * plugin reload that adds or drops a required setting takes effect at once.
 * Renders nothing for a built-in kind or a plugin with nothing required and no
 * setup steps.
 */
export function PluginKindSetupStrip({ kind }: { kind: string }) {
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const config = registry[kind];
  if (
    (config?.hasRequiredSettings !== true && config?.hasSetupSteps !== true) ||
    !config.extensionId
  ) {
    return null;
  }
  return <PluginSetupStrip pluginId={config.extensionId} />;
}
