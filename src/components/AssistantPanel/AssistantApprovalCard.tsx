import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantApproval } from "@/store/assistantStore";

/**
 * The approval surface — the one place in this panel where getting the interaction
 * wrong has consequences beyond aesthetics.
 *
 * ## The typed-confirm rule is not ours to decide
 *
 * `needsTypedConfirm` is the ENGINE's verdict, computed by its safety layer from the
 * dispatch's risk class and any per-tool override. It is carried on the wire
 * explicitly so this component never re-derives it: a UI that decided for itself
 * which risk classes are irreversible would be a second copy of a security rule,
 * free to drift permissively while looking correct.
 *
 * So: when the flag is set, an ordinary click cannot approve. The exact phrase must
 * be typed. That mirrors Daintree's own D3 destructive tier and the engine's REPL.
 *
 * ## Why the args summary is shown
 *
 * A confirmation that says only "git.push wants to run" asks someone to approve a
 * thing they cannot see. The summary is redacted at the engine's confirm boundary
 * (credentials masked before any structural collapse), so showing it is safe and
 * withholding it would make the prompt unanswerable.
 */

/** The phrase a typed confirmation demands. Matches the engine's REPL. */
const CONFIRM_PHRASE = "confirm";

export interface AssistantApprovalCardProps {
  approval: AssistantApproval;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => void;
  /**
   * Approve AND stop asking for this tool for the rest of the session.
   *
   * Offered only when the engine marked the approval rememberable — git and system
   * actions never are, and the panel does not get to decide otherwise.
   */
  onGrant?: (approval: AssistantApproval, uses: number) => void;
  /** Focus may move only within a visible assistant surface, without interrupting typing. */
  visible?: boolean;
}

/** Uses a bounded grant covers, matching the cockpit's own "A allow 5×". */
/**
 * Approval buttons, drawn in the TERMINAL's palette and sized off the panel.
 *
 * `<Button>` is deliberately not used here. Its variants resolve to app-theme colours —
 * `destructive` is the app's red, `outline` the app's border — and this card sits on
 * the terminal's ground. On a light app theme with a dark terminal that produced a card
 * whose buttons belonged to a different colour scheme than the surface under them. Its
 * `size="sm"` is also a fixed 12px label in a 28px box, so the buttons were the one part
 * of the card that ignored the terminal font size the rest of the panel follows.
 *
 * The three weights are the cockpit's, and they are what make the DEFAULT visible:
 *
 *   weighted — literal inverse video, exactly as render_approval.go drew DECLINE. Ink
 *              becomes the ground and the ground becomes the ink, which is the strongest
 *              thing a terminal can say and the reason it belongs on the safe answer.
 *   outline  — the action that needs a deliberate reach.
 *   ghost    — standing grants, which widen authority beyond this one call and must
 *              never be the easiest button on the card.
 */
const APPROVAL_BUTTON = cn(
  "min-h-7 rounded-sm px-3 py-1 assistant-text-sm font-medium select-none",
  "cursor-pointer transition-colors duration-150 ease-out",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]",
  "disabled:pointer-events-none disabled:opacity-50",
  "active:scale-[0.98] active:duration-[1ms]"
);
const APPROVAL_WEIGHTED = cn(
  APPROVAL_BUTTON,
  // Inverse video, as render_approval.go drew DECLINE. Hover deepens the fill AWAY
  // from the label instead of filtering the button: `brightness()` scales the label
  // too, so on a light terminal it lightens a dark fill toward its light text and
  // weakens the very contrast the weight exists to carry.
  "bg-[var(--assistant-fg)] text-[var(--assistant-surface)]",
  "hover:bg-[color-mix(in_oklab,var(--assistant-fg)_88%,var(--assistant-focus))]",
  // Labels may wrap at large terminal sizes without leaving the decision surface.
  "inline-flex max-w-full items-center justify-center whitespace-normal text-center"
);
const APPROVAL_OUTLINE = cn(
  APPROVAL_BUTTON,
  "border border-[var(--assistant-border-strong)] text-[var(--assistant-fg)]",
  "hover:bg-[var(--assistant-hover)]",
  "inline-flex max-w-full items-center justify-center whitespace-normal text-center"
);
const APPROVAL_GHOST = cn(
  APPROVAL_BUTTON,
  "text-[var(--assistant-fg-secondary)] hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]",
  "inline-flex max-w-full items-center justify-center whitespace-normal text-center"
);
/** A typed confirm's go button. Danger reads in the terminal's own red. */
const APPROVAL_DANGER = cn(
  APPROVAL_BUTTON,
  "bg-[var(--assistant-danger)] text-[var(--assistant-surface)]",
  "hover:bg-[color-mix(in_oklab,var(--assistant-danger)_88%,var(--assistant-fg))]",
  "inline-flex max-w-full items-center justify-center whitespace-normal text-center"
);

const BOUNDED_GRANT_USES = 5;

/**
 * A verb-noun label for the approve action, derived from the tool being run.
 *
 * "Approve" alone breaks the destructive-button rule and, worse, is unanswerable
 * out of context: on a stack of cards every button reads the same. Naming the act
 * means the button still says what it does when it is the only thing you look at.
 */
function approveLabel(toolId: string): string {
  const verb = toolId.split(".").pop() ?? "";
  switch (verb) {
    case "push":
      return "Push commits";
    case "merge":
    case "mergePR":
      return "Merge";
    case "delete":
      return "Delete";
    case "commit":
      return "Commit";
    case "sendCommand":
      return "Run command";
    default:
      return "Approve";
  }
}

export function AssistantApprovalCard({
  approval,
  onDecide,
  onGrant,
  visible = true,
}: AssistantApprovalCardProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const phraseMatches = typed.trim().toLowerCase() === CONFIRM_PHRASE;
  const approve = approveLabel(approval.toolId);

  /**
   * One decision per card, enforced here.
   *
   * The card does not disappear when you answer it — the decision is sent to the
   * engine, and the card is removed when the engine's `approval:decided` comes back.
   * That is the correct order (the panel must not claim an authorisation the engine has
   * not acknowledged), but it leaves a live card on screen for a round trip, and every
   * control on it still works: a double-click sends the same answer twice, and Y
   * immediately after clicking Decline sends the OPPOSITE answer to a dispatch that has
   * already been refused.
   *
   * A ref rather than state because it must take effect within the same event, before
   * any re-render, and because nothing renders from it — the card deliberately keeps its
   * appearance while it waits, so the answer does not look like it went missing.
   */
  const decidedRef = useRef(false);
  useEffect(() => {
    decidedRef.current = false;
  }, [approval.approvalId]);

  const decideOnce = useCallback(
    (decision: "approved" | "rejected") => {
      if (decidedRef.current) return;
      decidedRef.current = true;
      onDecide(approval.approvalId, decision);
    },
    [onDecide, approval.approvalId]
  );

  const grantOnce = useCallback(
    (uses: number) => {
      if (decidedRef.current || !onGrant) return;
      decidedRef.current = true;
      onGrant(approval, uses);
    },
    [onGrant, approval]
  );

  useEffect(() => {
    if (!visible) return;
    const surface = cardRef.current?.closest("[data-assistant-surface]");
    // Arriving decisions cannot capture a keystroke intended for another pane.
    if (!surface || !surface.contains(document.activeElement)) return;
    if (document.activeElement?.closest("input, textarea, [contenteditable='true']")) return;
    if (approval.needsTypedConfirm) inputRef.current?.focus();
    else cardRef.current?.focus();
  }, [approval.needsTypedConfirm, approval.approvalId, visible]);

  /**
   * The cockpit's single-key controls (render_approval.go renderActionRows): Y approve,
   * N decline, A allow a bounded number, F always, Esc decline.
   *
   * Escape DECLINES rather than dismissing. There is nothing to dismiss — the engine has
   * parked a dispatch and is waiting — so the only honest reading of "get this off my
   * screen" is the fail-closed one, which is what the cockpit spelled out as
   * "Esc decline".
   *
   * Every one of these is suppressed for a typed confirmation: that variant exists to
   * make approval cost something deliberate, and a one-key approve would hand back
   * exactly the friction it was added to impose.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      // Escape declines even on a typed confirmation. The friction that variant exists
      // to add is friction on APPROVING; making the fail-closed exit harder too just
      // strands someone in front of a sheet with no way out, and the cockpit bound
      // "Esc decline" on every approval it drew.
      if (key === "escape") {
        e.preventDefault();
        decideOnce("rejected");
        return;
      }
      // Every remaining shortcut is an APPROVAL in one form or another, so none of them
      // apply here: a one-key approve would hand back the exact friction the typed
      // phrase was added to impose.
      if (approval.needsTypedConfirm) return;
      if (key === "n") {
        e.preventDefault();
        decideOnce("rejected");
        return;
      }
      if (key === "y") {
        e.preventDefault();
        decideOnce("approved");
        return;
      }
      // `grantOnce` already refuses when there is no `onGrant`, so this only decides
      // whether A and F are SWALLOWED. Reading `approval.rememberable` alone keeps the
      // handler's dependencies to the two callbacks and the approval — the React
      // Compiler bails out of the whole component when a manual dependency list and the
      // inferred one disagree, and the bailout is silent in production.
      if (!approval.rememberable) return;
      if (key === "a") {
        e.preventDefault();
        grantOnce(BOUNDED_GRANT_USES);
        return;
      }
      if (key === "f") {
        e.preventDefault();
        grantOnce(Number.POSITIVE_INFINITY);
      }
    },
    [approval, decideOnce, grantOnce]
  );

  return (
    <div
      ref={cardRef}
      // Focusable so the scoped single-key controls have somewhere to land.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Approval required"
      // This sheet OWNS Escape — it DECLINES, as render_approval.go bound it. Without
      // the marker Escape declined the tool and hid the panel in one keystroke.
      data-escape-owner="approval"
      className={cn(
        "assistant-decision border border-[var(--assistant-border-strong)] border-l-2 border-l-[var(--assistant-warning-graphic)]",
        "rounded-sm bg-[var(--assistant-surface)] px-3 py-3",
        // Focus is taken programmatically, so :focus-visible never fires — the ring has
        // to hang off plain :focus or the card would hold every key with nothing on
        // screen saying so.
        //
        // An OUTLINE, not a box-shadow. Forced-colors mode drops shadows entirely, and
        // this is the one surface in the app where losing the focus indicator means not
        // knowing which card is about to receive the Y you are about to press.
        "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--assistant-focus)]"
      )}
    >
      {/* The shield marks the HEADING, and stops there.

          It used to sit in a column beside the whole card body, so every line under it —
          the summary, the consequence, the arguments, the confirm field, the buttons —
          began 38px inboard of the transcript's own axis, and the destination branch
          wrapped before the reader reached the sentence saying what would happen to it.
          A rail this narrow cannot spend a permanent icon column on a card that already
          has a warning-coloured left rail saying the same thing. */}
      <p className="assistant-mark-row mb-2 flex items-center assistant-text-sm text-[var(--assistant-warning)]">
        <ShieldAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--assistant-warning-graphic)]"
        />
        Approval required
      </p>
      <p className="assistant-text-base font-medium text-[var(--assistant-fg)]">
        {approval.summary}
      </p>

      {/* The consequence in the engine's own words — what actually happens. */}
      {approval.consequence && (
        <p className="mt-1 assistant-text-base text-[var(--assistant-fg-secondary)]">
          {approval.consequence}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="assistant-text-sm text-[var(--assistant-fg-secondary)]">
          {approval.toolId}
        </span>
        {approval.riskClass && (
          // Bordered and labelled. Unlabelled and borderless, this read as part of
          // the tool id — "git.push git" — which is worse than omitting it.
          <span
            className={cn(
              "rounded-sm border border-[var(--assistant-border)] bg-[var(--assistant-inset)] px-1.5 py-px",
              "assistant-text-sm text-[var(--assistant-fg-secondary)]"
            )}
          >
            risk: <span className="text-[var(--assistant-fg)]">{approval.riskClass}</span>
          </span>
        )}
      </div>

      {approval.argsSummary && (
        <pre
          tabIndex={0}
          aria-label="Action arguments"
          className={cn(
            "mt-2 max-h-40 overflow-y-auto rounded-sm border border-[var(--assistant-border)] bg-[var(--assistant-inset)] px-2 py-2",
            // WRAP rather than scroll sideways. A summary that clips mid-token
            // ("…,\"forc") hides the part of the argument someone is being asked
            // to approve, and gives no cue that anything is hidden.
            "whitespace-pre-wrap break-all",
            "assistant-text-sm text-[var(--assistant-fg-secondary)]",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
          )}
        >
          {approval.argsSummary}
        </pre>
      )}

      {approval.needsTypedConfirm ? (
        <div className="mt-2.5">
          <label
            htmlFor={`confirm-${approval.approvalId}`}
            className="block assistant-text-base text-[var(--assistant-fg-secondary)]"
          >
            {/* Names the act rather than repeating generic irreversibility
                    boilerplate — the specific consequence is already stated above. */}
            This can&rsquo;t be undone. Type{" "}
            <span className="text-[var(--assistant-fg)]">{CONFIRM_PHRASE}</span> to continue.
          </label>
          <div className="mt-1.5 flex flex-wrap justify-end gap-2">
            <input
              id={`confirm-${approval.approvalId}`}
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && phraseMatches) {
                  decideOnce("approved");
                }
              }}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "min-h-7 w-full min-w-0 rounded-sm border border-[var(--assistant-border)] bg-[var(--assistant-inset)]",
                "px-2 py-1 assistant-text-base text-[var(--assistant-fg)]",
                "placeholder:text-[var(--assistant-fg-dim)]",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
              )}
              placeholder={CONFIRM_PHRASE}
            />
            {/* Safe action left, destructive primary right — the same order every
                    confirm dialog in the app uses, so muscle memory does not betray
                    someone on the one surface where it matters most. */}
            <button type="button" className={APPROVAL_GHOST} onClick={() => decideOnce("rejected")}>
              Cancel
            </button>
            <button
              type="button"
              className={APPROVAL_DANGER}
              disabled={!phraseMatches}
              onClick={() => decideOnce("approved")}
            >
              {approve}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {/* DECLINE is the visual default, as it was in the cockpit, where it was
                  drawn in inverse video (render_approval.go:12 — "visually defaulting to
                  DECLINE"). This card had it the other way round: approve carried the
                  weighted button and decline was a ghost labelled "Cancel". That inverts
                  a fail-closed default into a fail-open one, and it does so precisely
                  where a reflex click is most likely — the button that looks like the
                  one you are meant to press was the one that authorises the action.

                  "Decline", not "Cancel": cancel reads as dismissing the dialog, when
                  what it actually does is answer the model. */}
          <button
            type="button"
            className={APPROVAL_WEIGHTED}
            onClick={() => decideOnce("rejected")}
          >
            Decline
          </button>
          <button type="button" className={APPROVAL_OUTLINE} onClick={() => decideOnce("approved")}>
            {approve}
          </button>
          {/* Standing approvals, on the engine's verdict alone. A bounded grant
                  sits before the unbounded one so the smaller commitment is the easier
                  reach, and both stay ghost: they widen authority beyond this one call,
                  so neither should ever be the easiest button on the card. */}
          {approval.rememberable && onGrant && (
            <>
              <button
                type="button"
                className={APPROVAL_GHOST}
                title={`Allow ${approval.toolId} up to ${BOUNDED_GRANT_USES} times`}
                onClick={() => grantOnce(BOUNDED_GRANT_USES)}
              >
                Allow {BOUNDED_GRANT_USES}×
              </button>
              <button
                type="button"
                className={APPROVAL_GHOST}
                title={`Allow ${approval.toolId} for the rest of this session`}
                onClick={() => grantOnce(Number.POSITIVE_INFINITY)}
              >
                Allow this session
              </button>
            </>
          )}
        </div>
      )}

      {!approval.needsTypedConfirm && (
        // The cockpit printed these beside the buttons; a key that exists and is
        // never mentioned is a key nobody presses. Decline leads, matching both the
        // button order and the fail-closed default.
        <p className="mt-1.5 assistant-text-sm text-[var(--assistant-fg-secondary)]">
          <span className="text-[var(--assistant-fg)]">N</span> decline ·{" "}
          <span className="text-[var(--assistant-fg)]">Y</span> {approve.toLowerCase()}
          {approval.rememberable && onGrant && (
            <>
              {" · "}
              <span className="text-[var(--assistant-fg)]">A</span> allow {BOUNDED_GRANT_USES}× ·{" "}
              <span className="text-[var(--assistant-fg)]">F</span> this session
            </>
          )}{" "}
          · <span className="text-[var(--assistant-fg)]">Esc</span> decline
        </p>
      )}
    </div>
  );
}
