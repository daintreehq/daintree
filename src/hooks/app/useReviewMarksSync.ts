import { useEffect } from "react";
import { startReviewMarksSync } from "@/store/reviewMarksStore";

/**
 * Keeps this view's review marks in step with the host's (#14584). Lives at
 * the app, not in Review Hub, so a mark made in another window reaches every
 * surface of this one, whatever is open.
 */
export function useReviewMarksSync(): void {
  useEffect(() => startReviewMarksSync(), []);
}
