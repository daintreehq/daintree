import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { CornerDownLeft } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { useArmedCrossHostTargets } from "./crossHostFleet";
import { sendDraftToFleet } from "./fleetEnterBroadcast";

/** One line of `text-xs` plus the field's padding and border. */
const ONE_LINE_PX = 24;

/**
 * The field's text, kept past the field: when the fleet empties or is exited
 * mid-draft, arming the next remote fleet brings back what wasn't delivered.
 */
let keptDraft = "";

/**
 * The fleet's own message field, shown only when no pane here is armed: a
 * fleet made entirely of agents on other hosts has no composer to type in.
 * It wraps instead of scrolling sideways, growing down over the grid rather
 * than resizing the bar, and it stays editable while a send runs.
 */
export function FleetHostComposer(): ReactElement {
  const targets = useArmedCrossHostTargets();
  const [draft, setDraft] = useState(() => keptDraft);
  const [sending, setSending] = useState(false);
  const [tall, setTall] = useState(false);
  const sendingRef = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // The chip beside the field names the hosts; the placeholder stays short
  // enough never to be cut mid-sentence at narrow widths.
  const hosts = [...new Set(targets.map((target) => target.hostName))].join(" and ");
  const recipients =
    targets.length === 1 ? `“${targets[0]!.title}”` : pluralize(targets.length, "agent");

  useEffect(() => {
    keptDraft = draft;
  }, [draft]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field) setTall(field.offsetHeight > ONE_LINE_PX + 2);
  }, [draft]);

  const submit = async () => {
    const submitted = draft;
    const text = submitted.trim();
    if (text.length === 0 || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // Cleared only once an agent took it, and only what was sent: a send that
      // reached nobody keeps the draft, and a next message typed meanwhile stays.
      if (await sendDraftToFleet(text)) {
        setDraft((current) => (current === submitted ? "" : current));
        // The field may be gone by now, and with it the effect that mirrors it.
        if (keptDraft === submitted) keptDraft = "";
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const empty = draft.trim().length === 0;

  return (
    <form
      className="relative h-6 min-w-[12rem] flex-1"
      aria-busy={sending || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="absolute inset-x-0 top-0 z-20">
        <Textarea
          ref={fieldRef}
          rows={1}
          density="compact"
          resize="none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
              return;
            }
            // Esc clears a typed message before it can exit the fleet.
            if (e.key === "Escape" && draft.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              setDraft("");
            }
          }}
          placeholder={`Message ${pluralize(targets.length, "agent")}`}
          aria-label={`Message ${recipients} on ${hosts}`}
          data-testid="fleet-host-composer"
          className={cn(
            "block min-h-6 py-[3px] pl-2 pr-8 text-xs leading-4",
            // Content sizing measures the placeholder too, so an empty field holds
            // one line instead of growing to show the hint.
            draft.length === 0 ? "h-6 overflow-hidden" : "max-h-40 field-sizing-content",
            // Past one line it floats over the grid, so it takes the floating shadow.
            tall && "shadow-[var(--theme-shadow-floating)]"
          )}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="submit"
              // Keeps the caret in the field, so the next message is one keystroke away.
              onMouseDown={(e) => e.preventDefault()}
              aria-disabled={empty || sending || undefined}
              aria-label={`Send to ${recipients} on ${hosts}`}
              className={cn(
                "absolute right-0.5 bottom-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)]",
                // A 24px hit area around the 20px chip, which keeps the field's corner drawn.
                "before:absolute before:-inset-0.5 before:content-['']",
                "text-text-primary transition-colors hover:bg-overlay-medium",
                "aria-disabled:cursor-not-allowed aria-disabled:text-text-secondary aria-disabled:hover:bg-transparent"
              )}
            >
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Send (Enter) · new line (Shift+Enter)</TooltipContent>
        </Tooltip>
      </div>
    </form>
  );
}
