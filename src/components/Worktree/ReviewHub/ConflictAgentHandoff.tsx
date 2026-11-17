import { useId, useState } from "react";
import { Info, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { OPERATION_LABEL } from "@/components/Git/repoOperationCopy";
import { composeConflictAgentText, type ConflictAgentTextArgs } from "./conflictAgentText";

const NO_TARGET_HINT = "Open an agent terminal, then try sending again.";
const TOO_LARGE_HINT = "These conflicts are too large to send. Copy the file list into the agent.";

type ConflictAgentHandoffProps = ConflictAgentTextArgs;

/**
 * Offers the conflicted files to an agent through the send-to-agent palette,
 * the same transport as the failing-checks and review-threads hand-offs.
 *
 * Renders into the "Conflicted" band's wrapping flex row, the way the threads
 * hand-off sits in its own band: the button takes the band's right side and the
 * hint, when there is one, wraps onto a single line under the heading. The
 * band is sticky, so the hint stays one line.
 *
 * Callers mount it only while a conflict is left and key it by worktree, so a
 * hint raised for one worktree never outlives it.
 */
export function ConflictAgentHandoff(props: ConflictAgentHandoffProps) {
  const [hint, setHint] = useState<string | null>(null);
  const hintId = useId();

  const handleSend = () => {
    const text = composeConflictAgentText(props);
    if (!text) {
      setHint(TOO_LARGE_HINT);
      return;
    }
    if (
      openSendToAgentPaletteWithText({
        text,
        sourceLabel: props.operation ? OPERATION_LABEL[props.operation] : "Review Hub",
        title: "Conflicted files",
      })
    ) {
      setHint(null);
      return;
    }
    setHint(NO_TARGET_HINT);
  };

  return (
    <>
      <Button
        type="button"
        variant="subtle"
        size="xs"
        data-testid="conflict-send-to-agent"
        aria-describedby={hint ? hintId : undefined}
        onClick={handleSend}
        // `-my-1`: the band is sized by its label, and a 24px button would
        // grow it the moment the button lands.
        className="-my-1 shrink-0 transition-colors"
      >
        <Send aria-hidden="true" />
        Send conflicts to agent
      </Button>
      {/* Mounted empty with the button, so the hint is announced when it
          arrives rather than appearing already holding it. */}
      <p role="status" aria-live="polite" className="sr-only">
        {hint ?? ""}
      </p>
      {hint && (
        <p
          id={hintId}
          data-testid="conflict-send-to-agent-hint"
          className="basis-full flex min-w-0 items-center gap-2 text-xs text-text-secondary"
        >
          <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{hint}</span>
        </p>
      )}
    </>
  );
}
