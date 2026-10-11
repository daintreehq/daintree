import { useSyncExternalStore } from "react";
import { takeOverDrive } from "@/hooks/useHostConnection";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { notify } from "@/lib/notify";
import { usePanelStore } from "@/store/panelStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Taking control of a project, shared by every control that offers it (the
 * window banner, each pane's read-only strip, the host's in-use menu), so they
 * all show the same request in flight and none can send a second one.
 */

const pending = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const FOCUS_ATTEMPTS = 10;
/** How long the pane that took control says so: long enough to read, then out of the way. */
const CONTROL_CONFIRMATION_MS = 2500;

let confirmedPanel: string | null = null;
let confirmationTimer: ReturnType<typeof setTimeout> | null = null;

function confirmIn(panelId: string | null): void {
  if (confirmationTimer !== null) clearTimeout(confirmationTimer);
  confirmedPanel = panelId;
  emit();
  confirmationTimer = setTimeout(() => {
    confirmedPanel = null;
    confirmationTimer = null;
    emit();
  }, CONTROL_CONFIRMATION_MS);
}

/**
 * Put the keyboard back where the user was working: the pane they asked from,
 * else the focused pane. The pane's input reopens a render after the lease
 * lands, so this retries for a few frames rather than guessing when.
 */
function returnFocus(target: string | null): void {
  if (!target) return;
  let tries = 0;
  const attempt = () => {
    if (focusPanelInput(target) || ++tries >= FOCUS_ATTEMPTS) return;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Never rejects: a refusal is reported with a way to try again. */
export async function takeControl(projectId: string, panelId?: string): Promise<void> {
  if (pending.has(projectId)) return;
  pending.add(projectId);
  emit();
  try {
    // The lease change it lands is announced where every change of control is.
    await takeOverDrive(projectId);
    const target = panelId ?? usePanelStore.getState().focusedId;
    confirmIn(target);
    returnFocus(target);
  } catch (error) {
    notify({
      type: "error",
      context: { eventKind: "connectivity" },
      title: "Couldn't take control",
      message: formatErrorMessage(error, "The host didn't hand over the project."),
      actions: [
        {
          label: "Retry",
          variant: "primary",
          onClick: () => void takeControl(projectId, panelId),
        },
      ],
    });
  } finally {
    pending.delete(projectId);
    emit();
  }
}

/** Whether a take-control request for this project is in flight, from any control. */
export function useTakeControlPending(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? pending.has(projectId) : false),
    () => false
  );
}

/** The pane control just arrived in shows a short confirmation; null once it has gone. */
export function useControlConfirmed(panelId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => confirmedPanel === panelId,
    () => false
  );
}
