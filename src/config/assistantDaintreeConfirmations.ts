import type { HelpAssistantDaintreeConfirmations } from "@shared/types/ipc/api";

// One label set for the settings row and the confirm dialog (#13137), so the
// dialog names the same choice the user will find in settings.
// The confirm dialog's segmented control can't fit the long label beside the
// other three, so it shows `shortLabel` there and names it in full on hover
// and to a screen reader.
export const DAINTREE_CONFIRMATION_OPTIONS: {
  value: HelpAssistantDaintreeConfirmations;
  label: string;
  shortLabel?: string;
}[] = [
  { value: "inherit", label: "Follow agent setting" },
  { value: "always-ask", label: "Always ask" },
  { value: "never-ask", label: "Never ask" },
  { value: "ask-except", label: "Ask, except for…", shortLabel: "Except…" },
];
