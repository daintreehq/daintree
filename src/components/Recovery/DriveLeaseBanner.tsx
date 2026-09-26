import { useState } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { takeOverDrive } from "@/hooks/useHostConnection";
import { useDriveLeaseBanner } from "./driveLeaseState";
import { getDriveLeaseBannerCopy } from "./recoveryCopy";

/** Never rejects: a refusal is reported with a way to try again. */
async function takeOverProject(
  projectId: string,
  kind: "taken-from-host" | "driven-elsewhere"
): Promise<void> {
  try {
    // Through the connection sync so the input gate opens with the banner.
    await takeOverDrive(projectId);
  } catch (error) {
    notify({
      type: "error",
      context: { eventKind: "connectivity" },
      title: kind === "taken-from-host" ? "Couldn't take back" : "Couldn't take over",
      message: formatErrorMessage(error, "The host didn't hand over the project."),
      actions: [
        {
          label: "Retry",
          variant: "primary",
          onClick: () => void takeOverProject(projectId, kind),
        },
      ],
    });
  }
}

/**
 * Another machine drives this view's project. On the host's own screen it
 * offers to take the project back; on a client it offers to take over. Neutral:
 * nothing is wrong, the project is simply being used from somewhere else.
 */
export function DriveLeaseBanner() {
  const state = useDriveLeaseBanner();
  const hostName = useHostConnectionStore((s) => s.hostName ?? s.hostId ?? "The host");
  const [busy, setBusy] = useState(false);

  if (state === null) return null;

  const copy = getDriveLeaseBannerCopy(state, hostName);
  const projectId = state.projectId;

  const takeOver = () => {
    setBusy(true);
    void takeOverProject(projectId, state.kind).then(() => setBusy(false));
  };

  return (
    <InlineStatusBanner
      title={copy.title}
      description={copy.description}
      severity="neutral"
      role="status"
      animated={false}
      action={{
        id: "take-over",
        label: copy.actionLabel,
        variant: "primary",
        loading: busy,
        disabled: busy,
        onClick: takeOver,
      }}
    />
  );
}
