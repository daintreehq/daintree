import { useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalRecipe } from "@shared/types/project";
import { useProjectStore } from "@/store/projectStore";
import { HostSwitchDialog } from "./HostSwitchDialog";
import { HostProjectPicker } from "./HostProjectPicker";
import {
  currentHostProjectPickerRequest,
  dismissHostProjectPicker,
  registerHostProjectPickerHost,
  requestHostProjectPicker,
  subscribeHostProjectPicker,
} from "./hostProjectPickerRequests";
import { HostSetupRecipeConfirm } from "./HostSetupRecipeConfirm";
import { runPendingHostSetup } from "./pendingHostSetup";
import {
  completeHostSwitchRequest,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
  subscribeHostSwitchRequests,
} from "./hostSwitchRequests";

/**
 * Shows the switch dialog when an action asks for it, a host's project list
 * when a switch to that host had nothing to return to, and runs a setup
 * recipe left behind by a clone onto this view's host. Mount once per view.
 */
export function HostSwitchDialogHost() {
  const request = useSyncExternalStore(
    subscribeHostSwitchRequests,
    currentHostSwitchRequest,
    () => null
  );
  const pickerRequest = useSyncExternalStore(
    subscribeHostProjectPicker,
    currentHostProjectPickerRequest,
    () => null
  );
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [setupQuestion, setSetupQuestion] = useState<{
    recipe: TerminalRecipe;
    answer: (run: boolean) => void;
  } | null>(null);

  useEffect(() => registerHostSwitchDialogHost(), []);
  useEffect(() => registerHostProjectPickerHost(), []);

  // A new window opened onto a host with nothing to show there offers that
  // host's project list. Asked on mount, since a send before this view
  // listened would be lost, and again when main says one is waiting.
  useEffect(() => {
    const remoteHosts = window.electron?.remoteHosts;
    if (typeof remoteHosts?.takeProjectOffer !== "function") return;
    // The offer is handed out once, so an answer is never dropped: one that
    // lands after this effect was torn down (StrictMode's replay, a remount)
    // goes to whichever picker host is mounted by then, and requesting it is
    // refused when none is.
    const take = () => {
      remoteHosts.takeProjectOffer().then(
        (hostId) => {
          if (hostId !== null) requestHostProjectPicker(hostId);
        },
        () => {}
      );
    };
    take();
    return remoteHosts.onEvent?.((event) => {
      if (event.type === "project-offer") take();
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const remoteHosts = window.electron?.remoteHosts;
    if (typeof remoteHosts?.isInUse !== "function") return;
    let cancelled = false;
    // The question this effect opened, settled exactly once: by the person,
    // or as a no when the view moves to another project or goes away.
    let settle: ((run: boolean) => void) | null = null;
    const confirm = (recipe: TerminalRecipe) =>
      new Promise<boolean>((resolve) => {
        if (cancelled) {
          resolve(false);
          return;
        }
        const answer = (run: boolean) => {
          if (settle !== answer) return;
          settle = null;
          setSetupQuestion((open) => (open?.answer === answer ? null : open));
          resolve(run && !cancelled);
        };
        settle = answer;
        setSetupQuestion({ recipe, answer });
      });
    void remoteHosts
      .isInUse()
      .then((inUse) => (inUse && !cancelled ? runPendingHostSetup(projectId, confirm) : undefined))
      .catch(() => {});
    return () => {
      cancelled = true;
      settle?.(false);
    };
  }, [projectId]);

  return (
    <>
      {request && (
        <HostSwitchDialog
          key={request.id}
          request={request}
          onClose={() => dismissHostSwitchRequest(request.id)}
          onComplete={() => completeHostSwitchRequest(request.id)}
        />
      )}
      {setupQuestion && (
        <HostSetupRecipeConfirm recipe={setupQuestion.recipe} onAnswer={setupQuestion.answer} />
      )}
      {pickerRequest && (
        <HostProjectPicker
          key={pickerRequest.id}
          hostId={pickerRequest.hostId}
          onClose={() => dismissHostProjectPicker(pickerRequest.id)}
        />
      )}
    </>
  );
}
