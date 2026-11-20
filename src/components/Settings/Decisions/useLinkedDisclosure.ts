import { useState } from "react";
import { useSettingsDeepLink } from "@/components/Settings/settingsDeepLink";

/**
 * Open state for a disclosure that a settings deep link can name. A link to a
 * row inside it opens it in the render that sees the link, so the dialog's
 * landing, which runs after that commit, finds the row, and it stays open once
 * the dialog clears the link. A second link to it opens it again after it was
 * closed. `searchOnly` ignores links that didn't come from settings search,
 * for a target other places link to for a different reason.
 */
export function useLinkedDisclosure(
  linkIds: readonly string[],
  { initial, searchOnly = false }: { initial: boolean; searchOnly?: boolean }
): readonly [boolean, (open: boolean) => void] {
  const link = useSettingsDeepLink();
  const [open, setOpen] = useState(initial);
  const [handled, setHandled] = useState<object | null>(null);
  const linked =
    link.request !== null &&
    link.sectionId !== null &&
    linkIds.includes(link.sectionId) &&
    (!searchOnly || link.query !== null);
  if (linked && handled !== link.request) {
    setHandled(link.request);
    setOpen(true);
  }
  return [open, setOpen] as const;
}
