import { Copy } from "lucide-react";
import { sanitizeErrorText } from "@/utils/errorText";
import { copyWithToast } from "@/lib/copyWithToast";
import type { BannerAction } from "./InlineStatusBanner";

/**
 * An error banner caps its description at 200 characters, which can clip the
 * actual cause out of a long shell error. This overflow item is where the whole
 * message can still be had. Null when there is nothing to copy.
 */
export function createCopyErrorAction(message: string): BannerAction | null {
  const fullMessage = sanitizeErrorText(message);
  if (!fullMessage) return null;
  return {
    id: "copy-error",
    label: "Copy error",
    icon: Copy,
    variant: "dismiss",
    // The overflow menu has closed by the time the copy settles, so it confirms
    // like every menu copy: a toast, and a Retry when the clipboard refuses.
    onClick: () => copyWithToast("Error", fullMessage),
  };
}
