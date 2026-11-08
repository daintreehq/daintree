import { useId, useState } from "react";
import { Info, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { composePrReviewThreadsAgentText, type ReviewThreadFile } from "./prReviewThreads";

const NO_TARGET_HINT = "Open an agent terminal, then try sending again.";

interface ReviewThreadsHandoffProps {
  worktreePath: string;
  prNumber: number;
  prUrl: string;
  files: readonly ReviewThreadFile[];
}

/**
 * Offers the pull request's unresolved review threads to an agent through the
 * send-to-agent palette, the same transport as the failing-checks hand-off.
 *
 * Renders into the "Changed vs {base}" band's wrapping flex row: the button
 * takes the band's right side, and the hint, when there is one, wraps onto a
 * single line of its own under the heading. One line, because the band is
 * sticky and every row it grows hides a row revealed under it.
 *
 * Callers mount it only while `files` is non-empty and key it by worktree and
 * PR number, so a hint raised for one pull request never outlives it.
 */
export function ReviewThreadsHandoff({
  worktreePath,
  prNumber,
  prUrl,
  files,
}: ReviewThreadsHandoffProps) {
  const [hint, setHint] = useState<string | null>(null);
  const hintId = useId();

  const handleSend = () => {
    const text = composePrReviewThreadsAgentText({ prNumber, prUrl, worktreePath, files });
    if (!text) return;
    if (
      openSendToAgentPaletteWithText({
        text,
        sourceLabel: `PR #${prNumber}`,
        title: "Unresolved review threads",
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
        data-testid="review-threads-send"
        aria-describedby={hint ? hintId : undefined}
        onClick={handleSend}
        // `-my-1`: the band is sized by its label, and a 24px button would
        // grow it the moment the decorations land.
        className="-my-1 shrink-0 transition-colors"
      >
        <Send aria-hidden="true" />
        Send review threads to agent
      </Button>
      {/* Mounted empty with the button, so the hint is announced when it
          arrives rather than appearing already holding it. */}
      <p role="status" aria-live="polite" className="sr-only">
        {hint ?? ""}
      </p>
      {hint && (
        <p
          id={hintId}
          data-testid="review-threads-send-hint"
          className="basis-full flex min-w-0 items-center gap-2 text-xs text-text-secondary"
        >
          <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{hint}</span>
        </p>
      )}
    </>
  );
}
