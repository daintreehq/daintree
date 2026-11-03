import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { SeverityMark } from "@/lib/statusSeverity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsRelayDeploy as RelayDeployState,
  DecisionsStatus,
} from "@shared/types/decisions";
import { openRelayDeployTerminal } from "./relayDeploy";
import { describeRelayDeploy, type RelayDeployNext } from "./relayDeployCopy";
import { landOnPairPhone } from "./pairPhoneLanding";
import { useGuidedTerminalPlacement } from "./useGuidedTerminalPlacement";

interface DecisionsRelayDeployProps {
  disabled: boolean;
  /** Closes Settings, then runs what's handed to it; absent outside the dialog. */
  onClose?: SettingsTabClose;
  /** The guided deploy this session started, as main reports it. */
  deploy?: RelayDeployState;
  /** Puts the deployed relay's URL in the field above and checks it. */
  onUseRelay: (url: string) => void;
  /** A claim finished from the outcome row settled: main's status when it saved, else null. */
  onClaimSettled?: (status: DecisionsStatus | null) => void;
  /** Takes the person on to pairing a phone; without it, Devices is landed on directly. */
  onPairPhone?: () => void;
}

const NEXT_LABEL: Record<RelayDeployNext, string> = {
  use: "Use this relay",
  "finish-claim": "Finish the claim",
  "accept-weak": "Use weaker storage",
  pair: "Pair a phone",
};

/**
 * How the guided deploy went, and main's claim of the relay it created
 * (#16200), as main reports them: shown whenever Settings looks, whether or
 * not it was open when the deploy ended. A claim that didn't save is finished
 * from here with the secret main still holds, which never comes here.
 */
export function DecisionsRelayDeployOutcome({
  deploy,
  disabled,
  onUseRelay,
  onClaimSettled,
  onPairPhone,
}: {
  deploy: RelayDeployState;
  disabled: boolean;
  onUseRelay: (url: string) => void;
  onClaimSettled?: (status: DecisionsStatus | null) => void;
  onPairPhone?: () => void;
}) {
  const [finishing, setFinishing] = useState(false);
  /**
   * A refusal main didn't record, kept with the claim it was asked against: a
   * claim main ran records how it ended on the deploy, which moves it on, so
   * the row says each refusal once. Compared by content, since every status
   * read brings a new copy of the same claim.
   */
  const [error, setError] = useState<{ claim: string; message: string } | null>(null);
  const outcome = describeRelayDeploy(deploy);
  const claim = JSON.stringify([deploy.id, deploy.claim ?? null]);

  const finishClaim = (acceptWeakStorage: boolean) => {
    if (finishing || disabled) return;
    setFinishing(true);
    setError(null);
    const askedAgainst = claim;
    let status: DecisionsStatus | null = null;
    window.electron.decisions
      .claimDeployedRelay({
        deployId: deploy.id,
        ...(acceptWeakStorage ? { acceptWeakStorage: true } : {}),
      })
      .then(
        (result) => {
          if (result.result === "saved") status = result.status;
        },
        (failure: unknown) =>
          setError({
            claim: askedAgainst,
            message: formatErrorMessage(failure, "Try again in a moment."),
          })
      )
      .then(() => {
        setFinishing(false);
        onClaimSettled?.(status);
      });
  };

  const act = () => {
    switch (outcome.next) {
      case "use":
        if (outcome.url !== undefined) onUseRelay(outcome.url);
        return;
      case "finish-claim":
        finishClaim(false);
        return;
      case "accept-weak":
        finishClaim(true);
        return;
      case "pair":
        if (onPairPhone) onPairPhone();
        else landOnPairPhone();
        return;
    }
  };
  const next = outcome.next;

  return (
    <SettingsRow
      id="decisions-deploy-outcome"
      label={outcome.label}
      accessory={
        outcome.severity ? (
          <SeverityMark
            severity={outcome.severity}
            label={outcome.label}
            className="h-3.5 w-3.5"
            decorative
          />
        ) : undefined
      }
      description={outcome.detail}
      error={
        error !== null && error.claim === claim
          ? `Couldn't claim the relay. ${error.message}`
          : undefined
      }
      disabled={disabled}
      control={
        next !== undefined
          ? ({ descriptionId, disabled: rowDisabled }) => (
              <Button
                variant="outline"
                size="sm"
                loading={finishing}
                disabled={rowDisabled || finishing}
                aria-describedby={descriptionId}
                onClick={act}
              >
                {NEXT_LABEL[next]}
              </Button>
            )
          : undefined
      }
    />
  );
}

/** Why a guided deploy's pane can't go anywhere this window shows. */
const PLACEMENT_REASON = {
  // Its terminals run on the Host, which can't reach the channel Daintree opens here.
  remote:
    "This window's terminals run on its Remote Host. Run the guided deploy from Settings → Decisions in a local project window",
  "no-project":
    "It runs in a terminal in this window. Open a project or a scratch here first, then start it",
} as const;

/**
 * "Don't have a relay yet?" (#16023, #16199): the guided deploy, the one route
 * to a relay in the user's own Cloudflare account. It closes Settings and runs
 * the published CLI in a pane the user watches, its answers prefilled from the
 * voice settings over a channel main holds, and what the CLI reports back
 * shows here. Main claims a relay the deploy completed by itself (#16200);
 * one it left unclaimed can be checked and claimed above with the claim
 * secret main received.
 */
export function DecisionsRelayDeploy({
  disabled,
  onClose,
  deploy,
  onUseRelay,
  onClaimSettled,
  onPairPhone,
}: DecisionsRelayDeployProps) {
  const placement = useGuidedTerminalPlacement();
  const [starting, setStarting] = useState(false);
  const running = deploy?.state === "running";

  const startGuidedDeploy = () => {
    if (!placement.ready || starting || running) return;
    const { cwd, worktreeId } = placement;
    const open = () => void openRelayDeployTerminal({ cwd, worktreeId });
    if (!onClose) {
      open();
      return;
    }
    setStarting(true);
    // Settings goes first, so the pane is in view and keeps the focus it takes.
    // Reopened before it had gone, it starts nothing and can be asked again.
    onClose((closed) => (closed ? open() : setStarting(false))).then(
      (closing) => {
        if (!closing) setStarting(false);
      },
      () => setStarting(false)
    );
  };

  return (
    <SettingsGroup label="Don't have a relay yet?">
      <SettingsRow
        id="decisions-relay-deploy"
        label="Deploy one to your own Cloudflare account"
        description="It creates a Worker (the relay, its Durable Object and the phone app) and a private R2 bucket there. Cloudflare's free plan is enough for one person, though R2 needs a payment method on file."
      />
      <SettingsRow
        id="decisions-deploy-guided"
        label="Guided deploy"
        description="Runs the published decisions deploy in a terminal you watch. It signs you in to Cloudflare in your browser, then asks for the Worker and bucket names and whether to turn on dictation transcription (xAI or OpenAI) and transcript cleanup (Anthropic or OpenAI), with their API keys. Your voice settings fill in the answers, a key Daintree holds shows only as present, and you can change any of them. Nothing is created until you confirm the summary. Needs Node.js 22 or later."
        disabled={disabled || !placement.ready || starting || running}
        disabledReason={
          !placement.ready
            ? placement.reason && PLACEMENT_REASON[placement.reason]
            : running
              ? "A guided deploy is running. Finish or close its terminal to start another"
              : undefined
        }
        control={({ descriptionId, disabled: rowDisabled }) => (
          <Button
            variant="outline"
            size="sm"
            loading={starting}
            disabled={rowDisabled}
            aria-describedby={descriptionId}
            onClick={startGuidedDeploy}
          >
            Guided deploy
          </Button>
        )}
      />
      {deploy && (
        <DecisionsRelayDeployOutcome
          deploy={deploy}
          disabled={disabled}
          onUseRelay={onUseRelay}
          onClaimSettled={onClaimSettled}
          onPairPhone={onPairPhone}
        />
      )}
    </SettingsGroup>
  );
}
