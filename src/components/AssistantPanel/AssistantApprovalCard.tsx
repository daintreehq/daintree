import { useEffect, useRef, useState } from "react";
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
}

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

export function AssistantApprovalCard({ approval, onDecide }: AssistantApprovalCardProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const phraseMatches = typed.trim().toLowerCase() === CONFIRM_PHRASE;
  const approve = approveLabel(approval.toolId);

  useEffect(() => {
    // Focus the field the decision actually depends on. Without this the keyboard
    // lands on the first button, where Enter would approve — the opposite of the
    // friction a typed confirmation exists to add.
    if (approval.needsTypedConfirm) inputRef.current?.focus();
  }, [approval.needsTypedConfirm, approval.approvalId]);

  return (
    <div
      role="group"
      aria-label="Approval required"
      className={cn(
        "rounded-lg border border-status-warning/40 bg-status-warning-surface",
        "px-3 py-2.5"
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
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDecide(approval.approvalId, "rejected")}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => onDecide(approval.approvalId, "approved")}>
                {approve}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
