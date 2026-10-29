import { Lock } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useControlFacts, useDriveLeaseAwaySeconds, useDriveLeaseBanner } from "./driveLeaseState";
import { getDriveLeaseBannerCopy, takeControlAriaLabel } from "./recoveryCopy";
import { takeControl, useTakeControlBusy } from "./takeControl";

/**
 * Another device controls this view's project. This is where the window
 * decides: it says the window is read-only, what and where the project is,
 * who has control, and what taking it does to them, and offers it — on the
 * host's own screen and on a client alike. The panes say it again only where
 * the user tried to type. Neutral: nothing is wrong, the project is simply in
 * use somewhere else. The change itself is announced once by the lease state,
 * not by this banner.
 */
export function DriveLeaseBanner() {
  const state = useDriveLeaseBanner();
  const facts = useControlFacts();
  const busy = useTakeControlBusy(state?.projectId);
  const awaySeconds = useDriveLeaseAwaySeconds();

  if (state === null || facts === null) return null;

  const copy = getDriveLeaseBannerCopy(facts, awaySeconds, busy);
  const projectId = state.projectId;

  return (
    <InlineStatusBanner
      // Read-only is the message itself, in the panes' and the gate's glyph.
      icon={Lock}
      title={copy.title}
      description={copy.description}
      severity="neutral"
      role="status"
      ariaLive="off"
      animated={false}
      // The action sits right under the consequence it carries, not across
      // the width of the window from it.
      layout="stacked"
      action={{
        id: "take-control",
        label: "Take control",
        ariaLabel: takeControlAriaLabel(facts),
        variant: "primary",
        loading: busy,
        onClick: () => void takeControl(projectId),
      }}
    />
  );
}
