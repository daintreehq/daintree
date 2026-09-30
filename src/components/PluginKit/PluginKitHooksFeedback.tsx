import { isValidElement, useId, useRef, useState } from "react";
import type { PluginConfirmPopoverProps, PluginToastTone } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { UNDO_ACTION_LABEL, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { combosFieldsEqual, keybindingService } from "@/services/KeybindingService";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useNotificationStore } from "@/store/notificationStore";
import { ALIGNS, SIDES, field, fn, nonEmpty, oneOf, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

// View toasts go through the same `notify()` the worker's `host.showToast`
// reaches over IPC, held to the same rules: a message of at most 2000
// characters, one of four tones, at most a minute on screen, the plugin's
// name in front of the message so a view cannot pass for the app, and the
// per-plugin rate-limit bucket. What a view adds is the action button, which
// the worker cannot wire because its callback would have to cross IPC; a view
// runs in this renderer, so the button calls straight back into it.

const TOAST_TONES = ["info", "success", "warning", "error"] as const;
const MESSAGE_MAX = 2000;
const ACTION_LABEL_MAX = 40;
const DURATION_MAX_MS = 60_000;

/** A plugin's name as a person reads it; never the machine-local instance key. */
export function pluginDisplayName(owner: string): string {
  const meta = usePluginRuntimeStore.getState().pluginMetaById.get(owner);
  if (meta?.displayName) return meta.displayName;
  // A project plugin's key is `project__{projectId}__{manifestId}`.
  const parts = owner.split("__");
  return parts.length >= 3 && parts[0] === "project" ? parts.slice(2).join("__") : owner;
}

function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, DURATION_MAX_MS)
    : undefined;
}

function readMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MESSAGE_MAX);
}

function once(run: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      run();
    } catch (error) {
      logError("[plugin-ui] toast action threw", error);
    }
  };
}

/**
 * Shows a toast for the view `owner` renders. Returns its id, or null when
 * the options are unusable (they are ignored rather than thrown on, like any
 * kit prop).
 */
export function showPluginViewToast(owner: string | null, options: unknown): string | null {
  if (typeof options !== "object" || options === null) return null;
  const message = readMessage(field(options, "message"));
  if (message === undefined) return null;
  const tone: PluginToastTone = oneOf(field(options, "tone"), TOAST_TONES) ?? "info";
  const rawAction = field(options, "action");
  let action: { label: string; onClick: () => void } | undefined;
  if (typeof rawAction === "object" && rawAction !== null) {
    const label = readMessage(field(rawAction, "label"));
    const onClick = field(rawAction, "onClick");
    if (label !== undefined && typeof onClick === "function") {
      action = {
        label: label.slice(0, ACTION_LABEL_MAX),
        onClick: once(() => {
          Reflect.apply(onClick, undefined, []);
        }),
      };
    }
  }
  // No event kind: a plugin's toast is its own, as on the worker's path.
  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
  return notify({
    type: tone,
    message: owner ? `${pluginDisplayName(owner)}: ${message}` : message,
    duration: readDuration(field(options, "durationMs")),
    rateLimitKey: owner ? `plugin:${owner}:${tone}` : undefined,
    action,
  });
}

// The live Undo toast of each plugin's views. An Undo toast is transient,
// which `notify()` exempts from its rate limit, so the cap lives here: a new
// one replaces the plugin's last, whose change the view's own history still
// holds. Keyed "" outside a plugin view.
const liveUndoToasts = new Map<string, string>();

/** Shows a success toast with the app's Undo button and Undo window. */
export function showPluginViewUndoToast(owner: string | null, options: unknown): string | null {
  if (typeof options !== "object" || options === null) return null;
  const message = readMessage(field(options, "message"));
  const onUndo = field(options, "onUndo");
  if (message === undefined || typeof onUndo !== "function") return null;
  const slot = owner ?? "";
  const previous = liveUndoToasts.get(slot);
  if (previous !== undefined) dismissPluginViewToast(previous);
  const undo = () => {
    Reflect.apply(onUndo, undefined, []);
  };
  const id = showUndoNotification(owner, message, undo, field(options, "durationMs"));
  liveUndoToasts.set(slot, id);
  return id;
}

function showUndoNotification(
  owner: string | null,
  message: string,
  onUndo: () => void,
  durationMs: unknown
): string {
  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
  return notify({
    type: "success",
    message: owner ? `${pluginDisplayName(owner)}: ${message}` : message,
    duration: readDuration(durationMs) ?? UNDO_TOAST_DURATION_MS,
    // The change is already visible where the user made it; the inbox would
    // only keep an Undo that no longer works.
    transient: true,
    action: {
      label: UNDO_ACTION_LABEL,
      onClick: once(onUndo),
    },
  });
}

export function dismissPluginViewToast(id: string): void {
  useNotificationStore.getState().dismissNotification(id);
}

/** Every combo a host binding fires on right now, in the scope the app is in. */
function* liveHostCombos(): Generator<{ actionId: string; combo: string }> {
  const scope = keybindingService.getScope();
  const seen = new Set<string>();
  for (const binding of keybindingService.getAllBindings()) {
    if (binding.scope !== "global" && binding.scope !== scope) continue;
    if (seen.has(binding.actionId)) continue;
    seen.add(binding.actionId);
    for (const combo of keybindingService.getEffectiveCombos(binding.actionId)) {
      yield { actionId: binding.actionId, combo };
    }
  }
}

/**
 * Whether the app's own shortcuts claim `event`: a binding on it, the first
 * key of a two-step chord, a chord already in progress, or a shortcut being
 * recorded. Reads the bindings without touching the chord state. A binding's
 * `when` clause is not evaluated, so a conditional binding always counts:
 * the view gives way rather than risk shadowing it.
 */
export function hotkeyHostOwnsEvent(event: KeyboardEvent): boolean {
  if (keybindingService.isCapturingShortcut()) return true;
  if (keybindingService.getPendingChord() !== null) return true;
  for (const { combo } of liveHostCombos()) {
    const first = combo.split(" ")[0];
    if (first && keybindingService.matchesEvent(event, first)) return true;
  }
  return false;
}

/** The action a host binding on `combo` runs, whatever its scope, or null. */
export function hotkeyHostBinding(combo: string): string | null {
  const wanted = combo.trim();
  if (wanted === "") return null;
  for (const binding of keybindingService.getAllBindings()) {
    for (const effective of keybindingService.getEffectiveCombos(binding.actionId)) {
      const first = effective.split(" ")[0];
      if (first && combosFieldsEqual(first, wanted)) return binding.actionId;
    }
  }
  return null;
}

function KitConfirmPopover({
  trigger,
  message,
  description,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  tone,
  open,
  defaultOpen,
  onOpenChange,
  side,
  align,
}: PluginConfirmPopoverProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const messageId = useId();
  const descriptionId = useId();
  const controlled = typeof open === "boolean";
  const [inner, setInner] = useState(defaultOpen === true);
  const isOpen = controlled ? open === true : inner;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const question = nonEmpty(message);
  if (!isValidElement(trigger) || question === undefined) return null;
  const danger = tone === "danger";
  const detail = nonEmpty(description);
  const confirm = fn(onConfirm);
  const cancel = fn(onCancel);
  const changeOpen = fn(onOpenChange);

  const setOpen = (next: boolean) => {
    if (!controlled) setInner(next);
    changeOpen?.(next);
  };
  const handleOpenChange = (next: boolean) => {
    // Escape, a click away or the trigger again: the same as Cancel.
    if (!next && isOpen) cancel?.();
    setOpen(next);
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        {...owner}
        side={oneOf(side, SIDES)}
        align={oneOf(align, ALIGNS)}
        role="alertdialog"
        aria-labelledby={messageId}
        aria-describedby={detail ? descriptionId : undefined}
        className={cn("w-64 max-w-[calc(100vw-2rem)] p-3", overlayZ)}
        onOpenAutoFocus={(event) => {
          // Focus goes to the safe answer when the action is a destructive one.
          event.preventDefault();
          (danger ? cancelRef : confirmRef).current?.focus();
        }}
      >
        <p id={messageId} className="text-xs font-medium text-text-primary">
          {question}
        </p>
        {detail ? (
          <p id={descriptionId} className="mt-1 text-xs text-balance text-text-secondary">
            {detail}
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="ghost"
            size="sm"
            className="text-text-secondary hover:text-text-primary"
            data-confirm-role="cancel"
            onClick={() => {
              cancel?.();
              setOpen(false);
            }}
          >
            {nonEmpty(cancelLabel) ?? "Cancel"}
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? "destructive" : "contrast"}
            size="sm"
            data-confirm-role="confirm"
            onClick={() => {
              setOpen(false);
              try {
                confirm?.();
              } catch (error) {
                logError("[plugin-ui] ConfirmPopover onConfirm threw", error);
              }
            }}
          >
            {nonEmpty(confirmLabel) ?? "Confirm"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const pluginKitHooksFeedback = {
  ConfirmPopover: KitConfirmPopover,
  showViewToast: showPluginViewToast,
  showViewUndoToast: showPluginViewUndoToast,
  dismissViewToast: dismissPluginViewToast,
  hotkeyHostOwnsEvent,
  hotkeyHostBinding,
};
