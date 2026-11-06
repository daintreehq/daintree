import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import { AppDialog, type DialogAction, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Callout } from "@/components/ui/Callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { InlineError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { PairingQrCode } from "./PairingQrCode";
import { formatCountdown, groupPairingCode, spokenPairingCode } from "./devicesCopy";
import { useDecisionsPairing, type PairingPhase } from "./useDecisionsPairing";

interface DecisionsPairingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** A phone was approved, so the device list is out of date. */
  onPaired: () => void;
  /** Where focus goes back to if the control that opened the dialog is gone by then. */
  restoreFocusTo?: RestoreFocusTarget;
}

/** The last minute is the one a person needs to notice. */
const FINAL_MINUTE_MS = 60_000;

/** What a screen reader hears as the pairing moves on. The countdown ticks aren't announced. */
function announce(state: PairingPhase): string {
  switch (state.phase) {
    case "starting":
      return "Making a pairing code…";
    case "waiting":
      return "Pairing code ready. Waiting for your phone to scan it.";
    case "responded":
      if (state.approving) return "Approving…";
      if (state.approvalSent) return `Checking whether ${state.answer.label} was paired.`;
      return `${state.answer.label} answered. Its code is ${spokenPairingCode(state.answer.code)}. Approve only if your phone shows the same digits.`;
    case "paired":
      return `${state.label} is paired.`;
    case "expired":
      return "The pairing code expired.";
    case "declined":
      return "Pairing declined.";
    case "changed":
      return "The phone wasn't approved.";
    case "start-failed":
      return state.message;
    default:
      return "";
  }
}

function Countdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const left = expiresAt - now;
  return (
    <p
      className={cn(
        "text-sm text-text-primary tabular-nums",
        left <= FINAL_MINUTE_MS && "font-medium"
      )}
    >
      Expires in {formatCountdown(left)}
    </p>
  );
}

/**
 * Pair a phone (#16009): a QR code for a one-time invitation, the same link
 * as text, then the six digits the phone's keys give, which the person
 * compares with the phone's own screen before approving. Closing while an
 * invitation is open rejects it on the relay, so the code can't be used later.
 */
export function DecisionsPairingDialog({
  isOpen,
  onClose,
  onPaired,
  restoreFocusTo,
}: DecisionsPairingDialogProps) {
  const pairing = useDecisionsPairing({ onPaired });
  const { state, now } = pairing;

  const begin = useEffectEvent(() => pairing.start());
  useEffect(() => {
    if (isOpen) begin();
  }, [isOpen]);

  // A phase that removes the focused control (Copy link once the phone
  // answers, the footer's buttons as they change) hands focus back to the
  // dialog itself; focus on a control that survived stays where it is.
  const [focusKey, setFocusKey] = useState(0);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    if (active === null || active === document.body) setFocusKey((key) => key + 1);
  }, [isOpen, state.phase]);

  // Closing never takes back an approval already sent: the hook leaves it to
  // finish and the device list hears when it lands.
  const close = () => {
    pairing.cancel();
    onClose();
  };

  const newCode: DialogAction = { label: "New code", onClick: () => pairing.start() };
  const closeAction: DialogAction = { label: "Close", onClick: close };

  const open = state.phase === "waiting" || state.phase === "responded" ? state.invitation : null;
  const finalMinute = open !== null && open.expiresAt - now <= FINAL_MINUTE_MS;
  // Its own live region, said once on crossing into the last minute and again
  // if a phone answers inside it, so the person comparing digits hears it too.
  // Nothing is left to approve once an approval was sent, so no warning then.
  const timeWarning =
    !finalMinute || (state.phase === "responded" && state.approvalSent)
      ? ""
      : state.phase === "responded"
        ? "Less than a minute left to approve."
        : "Less than a minute left on this pairing code.";

  let body: React.ReactNode = null;
  let primary: DialogAction | undefined;
  let secondary: DialogAction | undefined = { label: "Cancel", onClick: close };

  switch (state.phase) {
    case "idle":
    case "starting":
    case "waiting": {
      const invitation = state.phase === "waiting" ? state.invitation : null;
      body = (
        <div className="flex items-start gap-6">
          <div className="flex shrink-0 flex-col items-center gap-2.5">
            {invitation ? (
              <PairingQrCode value={invitation.url} />
            ) : (
              <SkeletonBone className="h-[271px] w-[271px] rounded-[var(--radius-md)]" />
            )}
            {invitation ? (
              <Countdown expiresAt={invitation.expiresAt} now={now} />
            ) : (
              <p className="text-sm text-text-secondary">Making a code…</p>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-4 pt-1">
            <ol className="list-decimal space-y-2.5 pl-4 text-sm text-text-primary marker:text-text-secondary">
              <li>On your phone, open the camera and scan this code. It works once.</li>
              <li>
                Your phone shows six digits. Daintree shows them here too, so you can check they
                match.
              </li>
            </ol>
            {invitation && (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Spinner size="sm" />
                Waiting for your phone…
              </p>
            )}
            {pairing.pollProblem && (
              <InlineError role="status">{`${pairing.pollProblem} Still checking…`}</InlineError>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">
                Or open this link on your phone
              </p>
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border-default bg-surface-input py-1.5 pr-1.5 pl-2.5">
                {/* Two lines, broken anywhere, so the relay's whole address shows
                    before the payload is cut. */}
                <span
                  className="line-clamp-2 min-w-0 flex-1 font-mono text-xs break-all text-text-primary select-text"
                  title={invitation?.url}
                >
                  {invitation?.url ?? "…"}
                </span>
                <CopyButton
                  text={invitation?.url ?? ""}
                  label="Copy link"
                  variant="ghost"
                  size="xs"
                  disabled={!invitation}
                />
              </div>
            </div>
            <Callout severity="info">
              On iPhone, open the link in Safari, then add Decisions to your Home Screen. iOS
              delivers notifications only to the Home Screen app.
            </Callout>
          </div>
        </div>
      );
      break;
    }
    case "responded": {
      const { answer, invitation } = state;
      // Past the deadline only an approval already sent is still open, and
      // only to find out whether it landed.
      const lapsed = now >= invitation.expiresAt;
      body = (
        <div className="space-y-4">
          <p className="text-sm font-medium text-text-primary">
            Do these six digits match your phone?
          </p>
          <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-input py-6 text-center">
            <p
              aria-hidden="true"
              className="font-mono text-4xl font-semibold tracking-[0.12em] text-text-primary tabular-nums"
            >
              {groupPairingCode(answer.code)}
            </p>
            <span className="sr-only">Code {spokenPairingCode(answer.code)}</span>
            <p className="mt-2 text-xs text-text-secondary">
              From <span className="font-medium text-text-primary">{answer.label}</span>
            </p>
          </div>
          <p className="text-sm text-text-secondary">
            Approving lets {answer.label} read and answer your agents&apos; questions. If any digit
            differs, decline: someone else may have answered this code.
          </p>
          {lapsed ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner size="sm" />
              {`Checking whether ${answer.label} was paired…`}
            </p>
          ) : (
            <Countdown expiresAt={invitation.expiresAt} now={now} />
          )}
          {state.approveError && <InlineError role="alert">{state.approveError}</InlineError>}
        </div>
      );
      primary = {
        label: "Approve",
        onClick: () => pairing.approve(),
        loading: state.approving,
        disabled: state.approving || lapsed,
      };
      // Once an approval was sent, declining could be untrue; Close leaves it to finish.
      secondary = state.approvalSent
        ? closeAction
        : { label: "Decline", onClick: () => pairing.decline(), disabled: state.approving };
      break;
    }
    case "paired":
      body = (
        <Callout severity="success" title={`${state.label} is paired`}>
          <p className="select-text">
            It can read and answer your agents&apos; questions now. Devices shows whether it gets
            notifications.
          </p>
        </Callout>
      );
      primary = { label: "Done", onClick: close };
      secondary = undefined;
      break;
    case "expired":
      body = (
        <Callout severity="warning" title="This pairing code expired">
          <p className="select-text">
            Codes work for five minutes. Make a new one when your phone is ready.
          </p>
        </Callout>
      );
      primary = newCode;
      secondary = closeAction;
      break;
    case "declined":
      body = (
        <Callout severity="info" title="Pairing declined">
          <p className="select-text">
            The phone wasn&apos;t added, and this code can&apos;t be used again.
          </p>
        </Callout>
      );
      primary = newCode;
      secondary = closeAction;
      break;
    case "changed":
      body = (
        <Callout severity="warning" title="The phone wasn't approved">
          <p className="select-text">
            What the relay held for this code changed before approval, so nothing was approved. Make
            a new code and pair again.
          </p>
        </Callout>
      );
      primary = newCode;
      secondary = closeAction;
      break;
    case "start-failed":
      body = (
        <Callout severity="error" title="Couldn't make a pairing code">
          <p className="select-text">{state.message}</p>
        </Callout>
      );
      primary = { label: "Retry", onClick: () => pairing.start() };
      secondary = closeAction;
      break;
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="lg"
      hasPreview
      initialFocus="surface"
      focusResetKey={focusKey}
      restoreFocusTo={restoreFocusTo}
      data-testid="decisions-pairing-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Pair a phone</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announce(state)}
        </span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {timeWarning}
        </span>
        {body}
      </AppDialog.Body>
      <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} />
    </AppDialog>
  );
}
