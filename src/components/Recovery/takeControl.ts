import { useSyncExternalStore } from "react";
import { takeOverDrive } from "@/hooks/useHostConnection";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { notify } from "@/lib/notify";
import { usePanelStore } from "@/store/panelStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isTakeControlPending, setTakeControlPending } from "./takeControlPending";

export { useTakeControlBusy, useTakeControlPending } from "./takeControlPending";

/**
 * Taking control of a project, shared by every control that offers it (the
 * window banner, the strip in a pane the user tried to type into, the waiting
 * gate, the file and plugin placeholders, the host's connected-machines menu),
 * so they all show the same request in flight and none can send a second one.
 */

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
  if (isTakeControlPending(projectId)) return;
  setTakeControlPending(projectId, true);
  // Where the user was when they asked, not wherever focus has wandered by
  // the time the host answers.
  const target = panelId ?? usePanelStore.getState().focusedId;
  try {
    // The lease change it lands is announced where every change of control is.
    await takeOverDrive(projectId);
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
    setTakeControlPending(projectId, false);
  }
}

/** The pane control just arrived in shows a short confirmation; null once it has gone. */
export function useControlConfirmed(panelId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => confirmedPanel === panelId,
    () => false
  );
}
