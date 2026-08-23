import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

/** Uses a bounded grant covers, matching the cockpit's own "A allow 5×". */
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

export function AssistantApprovalCard({ approval, onDecide, onGrant }: AssistantApprovalCardProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const phraseMatches = typed.trim().toLowerCase() === CONFIRM_PHRASE;
  const approve = approveLabel(approval.toolId);

  useEffect(() => {
    // Focus the field the decision actually depends on. Without this the keyboard
    // lands on the first button, where Enter would approve — the opposite of the
    // friction a typed confirmation exists to add.
    if (approval.needsTypedConfirm) {
      inputRef.current?.focus();
      return;
    }
    // The sheet takes the keys, as the cockpit's did — hints.go describes the composer
    // going unfocused because "an approval sheet is rendered above it and takes the
    // keys, where Escape DECLINES THE TOOL". Single-key controls that only work after
    // you happen to click the card are controls most people never find.
    cardRef.current?.focus();
  }, [approval.needsTypedConfirm, approval.approvalId]);

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
        onDecide(approval.approvalId, "rejected");
        return;
      }
      // Every remaining shortcut is an APPROVAL in one form or another, so none of them
      // apply here: a one-key approve would hand back the exact friction the typed
      // phrase was added to impose.
      if (approval.needsTypedConfirm) return;
      if (key === "n") {
        e.preventDefault();
        onDecide(approval.approvalId, "rejected");
        return;
      }
      if (key === "y") {
        e.preventDefault();
        onDecide(approval.approvalId, "approved");
        return;
      }
      if (!approval.rememberable || !onGrant) return;
      if (key === "a") {
        e.preventDefault();
        onGrant(approval, BOUNDED_GRANT_USES);
        return;
      }
      if (key === "f") {
        e.preventDefault();
        onGrant(approval, Number.POSITIVE_INFINITY);
      }
    },
    [approval, onDecide, onGrant]
  );

  return (
    <div
      ref={cardRef}
      // Focusable so the single-key controls have somewhere to land. Not focused
      // automatically unless it is the typed-confirm variant, which focuses its input:
      // stealing focus mid-sentence from someone typing in the composer would be worse
      // than making them reach for the card.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Approval required"
      className={cn(
        "rounded-lg border border-status-warning/40 bg-status-warning-surface",
        "px-3 py-2.5",
        // Focus is taken programmatically, so :focus-visible never fires — the ring has
        // to hang off plain :focus or the card would hold every key with nothing on
        // screen saying so.
        "focus:outline-hidden focus:ring-1 focus:ring-status-warning/50"
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{approval.summary}</p>

          {/* The consequence in the engine's own words — what actually happens. */}
          {approval.consequence && (
            <p className="mt-1 text-xs text-text-secondary">{approval.consequence}</p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="font-mono text-[10px] text-text-secondary">{approval.toolId}</span>
            {approval.riskClass && (
              // Bordered and labelled. Unlabelled and borderless, this read as part of
              // the tool id — "git.push git" — which is worse than omitting it.
              <span
                className={cn(
                  "rounded border border-border-subtle bg-surface-inset px-1.5 py-px",
                  "text-[10px] text-text-secondary"
                )}
              >
                risk: <span className="font-mono text-text-primary">{approval.riskClass}</span>
              </span>
            )}
          </div>

          {approval.argsSummary && (
            <pre
              className={cn(
                "mt-2 max-h-28 overflow-y-auto rounded bg-surface-inset px-2 py-1.5",
                // WRAP rather than scroll sideways. A summary that clips mid-token
                // ("…,\"forc") hides the part of the argument someone is being asked
                // to approve, and gives no cue that anything is hidden.
                "whitespace-pre-wrap break-all",
                "font-mono text-[10px] leading-relaxed text-text-secondary"
              )}
            >
              {approval.argsSummary}
            </pre>
          )}

          {approval.needsTypedConfirm ? (
            <div className="mt-2.5">
              <label
                htmlFor={`confirm-${approval.approvalId}`}
                className="block text-xs text-text-secondary"
              >
                {/* Names the act rather than repeating generic irreversibility
                    boilerplate — the specific consequence is already stated above. */}
                This can&rsquo;t be undone. Type{" "}
                <span className="font-mono text-text-primary">{CONFIRM_PHRASE}</span> to continue.
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  id={`confirm-${approval.approvalId}`}
                  ref={inputRef}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && phraseMatches) {
                      onDecide(approval.approvalId, "approved");
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    "min-w-0 flex-1 rounded-md border border-border-default bg-surface-input",
                    "px-2 py-1 font-mono text-xs text-text-primary",
                    "placeholder:text-text-placeholder",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
                  )}
                  placeholder={CONFIRM_PHRASE}
                />
                {/* Safe action left, destructive primary right — the same order every
                    confirm dialog in the app uses, so muscle memory does not betray
                    someone on the one surface where it matters most. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDecide(approval.approvalId, "rejected")}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!phraseMatches}
                  onClick={() => onDecide(approval.approvalId, "approved")}
                >
                  {approve}
                </Button>
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
              <Button size="sm" onClick={() => onDecide(approval.approvalId, "rejected")}>
                Decline
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDecide(approval.approvalId, "approved")}
              >
                {approve}
              </Button>
              {/* Standing approvals, on the engine's verdict alone. A bounded grant
                  sits before the unbounded one so the smaller commitment is the easier
                  reach, and both stay ghost: they widen authority beyond this one call,
                  so neither should ever be the easiest button on the card. */}
              {approval.rememberable && onGrant && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onGrant(approval, BOUNDED_GRANT_USES)}
                  >
                    Allow {BOUNDED_GRANT_USES}×
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onGrant(approval, Number.POSITIVE_INFINITY)}
                  >
                    Always allow
                  </Button>
                </>
              )}
            </div>
          )}

          {!approval.needsTypedConfirm && (
            // The cockpit printed these beside the buttons; a key that exists and is
            // never mentioned is a key nobody presses. Decline leads, matching both the
            // button order and the fail-closed default.
            <p className="mt-1.5 text-[10px] text-text-secondary opacity-70">
              <span className="font-mono">N</span> decline · <span className="font-mono">Y</span>{" "}
              {approve.toLowerCase()}
              {approval.rememberable && onGrant && (
                <>
                  {" · "}
                  <span className="font-mono">A</span> allow {BOUNDED_GRANT_USES}× ·{" "}
                  <span className="font-mono">F</span> always
                </>
              )}{" "}
              · <span className="font-mono">Esc</span> decline
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
