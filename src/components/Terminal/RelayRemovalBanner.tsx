import { InlineStatusBanner, type InlineStatusBannerSeverity } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { hostOf } from "@/components/Settings/Decisions/relayCheckCopy";
import { requestRelayUrl } from "@/components/Settings/Decisions/relayUrlRequest";
import type { RelayRemovalObservation } from "./useRelayRemoval";

export interface RelayRemovalCopy {
  /** Changes whenever what the banner says does, so a dismissal holds only until then. */
  key: string;
  /** Never success, which the banner only shows on a timer, and this stays until dismissed. */
  severity: Exclude<InlineStatusBannerSeverity, "success">;
  title: string;
  description: string;
  /** Where Settings → Decisions should land, when there is something to do there. */
  settingsSection?: "decisions-relay-url" | "decisions-relay-remove" | "decisions-data";
  actionLabel?: string;
}

const RUN_AGAIN = "Run the removal again from Settings to finish";

/**
 * What a removal pane says (#16202): what main saw of how the removal ended and
 * what it did with this computer's record, never what the CLI printed, which
 * stays the terminal's to show.
 */
export function describeRelayRemoval(observed: RelayRemovalObservation): RelayRemovalCopy {
  if ("unwatched" in observed) {
    return {
      key: "unwatched",
      severity: "warning",
      title: "No record of how this removal ended",
      description:
        "Daintree didn't watch this terminal in this run, so it can't say what the removal did. Settings → Decisions shows the relay this computer records now.",
      settingsSection: "decisions-relay-remove",
      actionLabel: "Open settings",
    };
  }
  const host = hostOf(observed.origin);
  const { outcome, recorded } = observed;
  const kept = recorded ? ` Daintree kept its record of ${host}.` : "";
  switch (outcome.state) {
    case "running":
      return {
        key: "running",
        severity: "info",
        title: "Follow the relay removal below",
        description: recorded
          ? `It lists what it found in Cloudflare and asks you to type the Worker's name before it deletes anything. Daintree forgets ${host} once it finishes.`
          : "It lists what it found in Cloudflare and asks you to type the Worker's name before it deletes anything. Nothing on this computer changes.",
      };
    case "interrupted":
      return {
        key: "interrupted",
        severity: "warning",
        title: "Relay removal didn't finish",
        description: `Daintree lost track of this removal before it said how it went, so part of the relay may still be in Cloudflare.${kept} ${RUN_AGAIN}.`,
        settingsSection: "decisions-relay-remove",
        actionLabel: "Open settings",
      };
    case "exited":
      break;
  }
  if (outcome.exitCode !== 0) {
    return {
      key: `exited-${outcome.exitCode}`,
      severity: "warning",
      title: "Relay removal didn't finish",
      description: `The removal exited with status ${outcome.exitCode}, so part of the relay may still be in Cloudflare; the terminal says why.${kept}`,
      settingsSection: "decisions-relay-remove",
      actionLabel: "Open settings",
    };
  }
  const finished = "The removal exited with status 0.";
  switch (outcome.local) {
    case "pending":
      return {
        key: "pending",
        severity: "info",
        title: "Relay removal finished",
        description: `${finished} Daintree is forgetting ${host} on this computer.`,
      };
    case "forgotten":
      return {
        key: "forgotten",
        severity: "neutral",
        title: "Relay removal finished",
        description: `${finished} Daintree forgot ${host} and removed its keys on this computer; the decision history stays.`,
        settingsSection: "decisions-relay-url",
        actionLabel: "Set up a relay…",
      };
    case "deleted":
      return {
        key: "deleted",
        severity: "neutral",
        title: "Relay removal finished",
        description: `${finished} Daintree forgot ${host} and deleted this computer's Decisions data.`,
        settingsSection: "decisions-relay-url",
        actionLabel: "Set up a relay…",
      };
    case "none":
    case "kept":
      return {
        key: "none",
        severity: "neutral",
        title: "Relay removal finished",
        description: `${finished} Nothing on this computer changed.`,
      };
    case "incomplete":
      return {
        key: "incomplete",
        severity: "warning",
        title: "Relay removal finished",
        description: `${finished} Daintree forgot ${host}, but deleting this computer's decision history didn't finish. Delete local data in Settings to try again.`,
        settingsSection: "decisions-data",
        actionLabel: "Open settings",
      };
    case "changed":
      return {
        key: "changed",
        severity: "warning",
        title: "Relay removal finished",
        description: `${finished} This computer records another relay identity now, so Daintree changed nothing here.`,
      };
    case "off":
      return {
        key: "off",
        severity: "warning",
        title: "Relay removal finished",
        description: `${finished} Decisions was off by then, so Daintree kept its record of ${host}. Turn Decisions on and disconnect it in Settings.`,
        settingsSection: "decisions-relay-remove",
        actionLabel: "Open settings",
      };
    case "failed":
      return {
        key: "failed",
        severity: "error",
        title: "Couldn't forget the removed relay",
        description: `${finished} Daintree couldn't forget ${host}, so it kept its record. Disconnect it in Settings.`,
        settingsSection: "decisions-relay-remove",
        actionLabel: "Open settings",
      };
  }
}

/**
 * Above a guided relay removal's pane (#16202): what main saw of it, and the
 * way back to Settings when something is left to do there.
 */
export function RelayRemovalBanner({
  copy,
  onDismiss,
}: {
  copy: RelayRemovalCopy;
  onDismiss: () => void;
}) {
  const section = copy.settingsSection;
  return (
    <InlineStatusBanner
      severity={copy.severity}
      title={copy.title}
      description={copy.description}
      action={
        section && copy.actionLabel
          ? {
              id: "relay-removal-settings",
              label: copy.actionLabel,
              onClick: () => {
                // The URL field shows only once Connection has the status, as after a deploy.
                if (section === "decisions-relay-url") requestRelayUrl();
                void actionService.dispatch(
                  "app.settings.openTab",
                  { tab: "decisions", sectionId: section },
                  { source: "user" }
                );
              },
            }
          : undefined
      }
      onClose={onDismiss}
    />
  );
}
