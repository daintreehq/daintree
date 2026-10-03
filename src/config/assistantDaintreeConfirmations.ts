import type { HelpAssistantDaintreeConfirmations } from "@shared/types/ipc/api";

// One label set for the settings row and the confirm dialog (#13137), so the
// dialog names the same choice the user will find in settings.
export const DAINTREE_CONFIRMATION_OPTIONS: {
  value: HelpAssistantDaintreeConfirmations;
  label: string;
}[] = [
  { value: "inherit", label: "Follow global setting" },
  { value: "always-ask", label: "Always ask" },
  { value: "never-ask", label: "Never ask" },
];
