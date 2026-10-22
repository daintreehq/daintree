import type { HibernationProjectHibernatedPayload } from "@shared/types";

export const hibernationClient = {
  onProjectHibernated: (
    callback: (payload: HibernationProjectHibernatedPayload) => void
  ): (() => void) => {
    return window.electron.hibernation.onProjectHibernated(callback);
  },
} as const;
