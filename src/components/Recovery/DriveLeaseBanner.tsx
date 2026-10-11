import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useDriveLeaseBanner } from "./driveLeaseState";
import { getDriveLeaseBannerCopy } from "./recoveryCopy";
import { takeControl, useTakeControlPending } from "./takeControl";

/**
 * Another device controls this view's project: names it and offers control
 * here, on the host's own screen and on a client alike. Neutral: nothing is
 * wrong, the project is simply being used from somewhere else. The change
 * itself is announced once by the lease state, not by this banner.
 */
export function DriveLeaseBanner() {
  const state = useDriveLeaseBanner();
  const hostName = useHostConnectionStore((s) => s.hostName ?? s.hostId ?? "The host");
  const busy = useTakeControlPending(state?.projectId);

  if (state === null) return null;

  const copy = getDriveLeaseBannerCopy(state, hostName);
  const projectId = state.projectId;

  return (
    <InlineStatusBanner
      title={copy.title}
      description={copy.description}
      severity="neutral"
      role="status"
      ariaLive="off"
      animated={false}
      // One line: who controls is context, not an alarm, and the window's
      // own sessions are what fill it.
      layout="inline"
      action={{
        id: "take-control",
        label: copy.actionLabel,
        variant: "primary",
        loading: busy,
        disabled: busy,
        onClick: () => void takeControl(projectId),
      }}
    />
  );
}
