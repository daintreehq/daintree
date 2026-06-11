import { useEffect, useRef } from "react";
import type { BootResult } from "@shared/types/ipc/app";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import { notify } from "@/lib/notify";

/**
 * Surfaces the Rosetta translation warning from the boot payload. The
 * condition is machine-level and session-stable (the installed binary's
 * architecture can't change mid-session), so the initial boot result is the
 * only source of truth — no re-check on project-switch hydrates.
 */
export function useRosettaWarning(bootResult: BootResult | null) {
  const inboxedRef = useRef(false);

  useEffect(() => {
    if (!bootResult) return;

    const visible =
      bootResult.runningUnderRosetta === true && bootResult.rosettaWarningDismissed !== true;
    useRosettaBannerStore.getState().setVisible(visible);

    // Inbox entry once per session — the banner is the live surface; the entry
    // is an audit trail that survives when a higher-priority global banner
    // suppresses the live banner. priority:"low" keeps it inbox-only; the
    // supersedeKey retires the prior row across launches; the ref guards
    // against re-firing on rerenders.
    if (visible && !inboxedRef.current) {
      inboxedRef.current = true;
      notify({
        type: "warning",
        priority: "low",
        title: "Running under Rosetta",
        message:
          "This is the Intel build running translated on Apple Silicon, which degrades performance. Download the Apple Silicon build from daintree.org/download.",
        supersedeKey: "rosetta-translation",
        countable: false,
        context: { eventKind: "host" },
      });
    }
  }, [bootResult]);
}
