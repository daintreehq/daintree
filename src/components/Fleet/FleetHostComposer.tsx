import { useState, type ReactElement } from "react";
import { Input } from "@/components/ui/input";
import { sendDraftToFleet } from "./fleetEnterBroadcast";

/**
 * The fleet's own message field, shown only when no pane here is armed: a
 * fleet made entirely of agents on other hosts has no composer to type in.
 */
export function FleetHostComposer({ memberCount }: { memberCount: number }): ReactElement {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    try {
      if (await sendDraftToFleet(text)) setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-1 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        density="compact"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Esc clears a typed message before it can exit the fleet.
          if (e.key === "Escape" && draft.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setDraft("");
          }
        }}
        disabled={sending}
        placeholder={`Message ${memberCount} agents`}
        aria-label={`Message all ${memberCount} agents in the fleet`}
        data-testid="fleet-host-composer"
        className="h-6 min-w-0"
      />
    </form>
  );
}
