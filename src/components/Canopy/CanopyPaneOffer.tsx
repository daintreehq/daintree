import { useEffect } from "react";
import { Telescope } from "@/components/icons";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useHostPlatform } from "@/hooks/useHostPlatform";
import { actionService } from "@/services/ActionService";
import { useCanopyStore } from "@/store/canopyStore";
import { CANOPY_LOCAL, CANOPY_STOP, canopyLocalOn, canopyStopOn } from "./canopyTerms";

/** How long the pane says Canopy is on before the note goes by itself. */
const TURNED_ON_DISMISS_MS = 10_000;

/** Inherited by the banner's paragraph: no lone word left on its last line. */
const PROSE = "[text-wrap:pretty]";

type CanopyState = ReturnType<typeof useCanopyStore.getState>;

/**
 * This view's host could be offered Canopy: main has answered, Canopy is off
 * there rather than hidden or on, and the offer wasn't put away.
 */
function offerable(state: CanopyState): boolean {
  const snapshot = state.snapshot;
  return (
    snapshot !== null &&
    state.mode === "unset" &&
    !snapshot.activated &&
    !state.outdatedHost &&
    !state.paneOfferDismissed
  );
}

export type CanopyPaneOfferState = "offer" | "turned-on" | null;

/**
 * What the pane shows of Canopy's offer: the offer while its agent is stopped
 * on a question or an approval and nothing reads its screen, if no other pane
 * holds it; the note that Canopy is on once the offer here turned it on.
 */
export function useCanopyPaneOffer(panelId: string, asking: boolean): CanopyPaneOfferState {
  const canOffer = useCanopyStore(offerable);
  const holder = useCanopyStore((state) => state.paneOfferHolder);
  const attempt = useCanopyStore((state) =>
    state.paneOfferAttempt?.panelId === panelId ? state.paneOfferAttempt.status : null
  );
  const turnedOn = useCanopyStore((state) => state.paneOfferTurnedOn === panelId);
  // Turning it on from here keeps the offer here until that settles, even if
  // the agent goes back to work meanwhile: its outcome is told where it was
  // asked. A refusal stays only while Canopy could still be offered.
  const wants = (asking && canOffer) || attempt === "pending" || (attempt === "failed" && canOffer);

  useEffect(() => {
    if (!wants) return;
    return () => useCanopyStore.getState().releasePaneOffer(panelId);
  }, [wants, panelId]);
  useEffect(() => {
    if (wants && holder === null) useCanopyStore.getState().claimPaneOffer(panelId);
  }, [wants, holder, panelId]);
  useEffect(() => () => useCanopyStore.getState().forgetPaneOffer(panelId), [panelId]);

  if (turnedOn) return "turned-on";
  return wants && holder === panelId ? "offer" : null;
}

/** `text` with each `name` in it kept on one line: a host name never breaks at its hyphen. */
function keepWhole(text: string, name: string | null): React.ReactNode {
  if (!name) return text;
  return text.split(name).flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={index} className="whitespace-nowrap">
            {name}
          </span>,
          part,
        ]
  );
}

export function CanopyPaneOffer({
  panelId,
  state,
  agentName,
  reason,
}: {
  panelId: string;
  state: Exclude<CanopyPaneOfferState, null>;
  agentName: string;
  /** What Daintree saw the agent stop on. */
  reason: "question" | "approval";
}) {
  const { hostName } = useHostPlatform();
  const attempt = useCanopyStore((s) =>
    s.paneOfferAttempt?.panelId === panelId ? s.paneOfferAttempt.status : null
  );
  const model = useCanopyStore((s) => s.snapshot?.model?.status);

  if (state === "turned-on") {
    const close = () => useCanopyStore.getState().closePaneOfferTurnedOn();
    if (model === "failed") {
      return (
        <InlineStatusBanner
          severity="error"
          title="Canopy's model isn't available"
          description={keepWhole(
            // Another host may be on a Daintree from before the model shipped
            // with it, whose download failed: updating it there helps either way.
            hostName
              ? `Canopy is on, but the model it reads with on ${hostName} isn't available. Updating or reinstalling Daintree there puts it back.`
              : "Canopy is on, but the model it reads with is missing or damaged. Reinstalling Daintree puts it back.",
            hostName
          )}
          onClose={close}
          className={PROSE}
          rootAttributes={{ "data-canopy-pane-offer": "turned-on" }}
        />
      );
    }
    // Reading only once the model is ready: until then it is being checked,
    // or a host from before the model shipped with Daintree is fetching it.
    const now =
      model === "ready"
        ? hostName
          ? `It's reading agents' screens on ${hostName}.`
          : "It's reading your agents' screens."
        : hostName
          ? `It starts reading agents' screens on ${hostName} once its model is ready.`
          : "It starts reading your agents' screens once its model is ready.";
    return (
      <InlineStatusBanner
        severity="success"
        icon={Telescope}
        title="Canopy is on"
        description={keepWhole(
          `${now} ${hostName ? canopyStopOn(hostName) : CANOPY_STOP}`,
          hostName
        )}
        action={{
          id: "open-canopy",
          label: "Open Canopy",
          // Through the toggle, so a Canopy window opened since comes forward.
          onClick: () => {
            void actionService.dispatch("canopy.toggle", undefined, { source: "user" });
          },
        }}
        autoDismissAfter={TURNED_ON_DISMISS_MS}
        onClose={close}
        className={PROSE}
        rootAttributes={{ "data-canopy-pane-offer": "turned-on" }}
      />
    );
  }

  const turnOn = () => {
    useCanopyStore.getState().startPaneOfferAttempt(panelId);
    window.electron.canopy.setMode("on").then(
      (snapshot) => {
        const store = useCanopyStore.getState();
        store.finishPaneOfferAttempt(panelId, true);
        store.applySnapshot(snapshot);
      },
      () => useCanopyStore.getState().finishPaneOfferAttempt(panelId, false)
    );
  };
  const dismiss = {
    onClose: () => useCanopyStore.getState().dismissPaneOffer(),
    closeAriaLabel: "Don't show this offer again",
    closeTitle: "Don't show this offer again",
    closeDisabled: attempt === "pending",
  };

  if (attempt === "failed") {
    return (
      <InlineStatusBanner
        severity="error"
        title="Couldn't turn on Canopy"
        description={keepWhole(
          hostName
            ? `Retry, or turn it on from Settings > Canopy on ${hostName}.`
            : "Retry, or turn it on from Settings > Canopy.",
          hostName
        )}
        action={{ id: "turn-on-canopy", label: "Retry", onClick: turnOn }}
        {...dismiss}
        className={PROSE}
        rootAttributes={{ "data-canopy-pane-offer": "failed" }}
      />
    );
  }

  return (
    <InlineStatusBanner
      severity="neutral"
      icon={Telescope}
      title={`${agentName}'s output looks like ${reason === "approval" ? "an approval prompt" : "a question"}`}
      description={keepWhole(
        `Canopy picks out the agents waiting on you, across every pane and worktree. ${hostName ? canopyLocalOn(hostName) : CANOPY_LOCAL}`,
        hostName
      )}
      action={{
        id: "turn-on-canopy",
        label: hostName ? `Turn on Canopy on ${hostName}` : "Turn on Canopy",
        onClick: turnOn,
        loading: attempt === "pending",
      }}
      {...dismiss}
      className={PROSE}
      rootAttributes={{ "data-canopy-pane-offer": "offer" }}
    />
  );
}
