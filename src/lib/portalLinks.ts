import type { PortalLink } from "@shared/types";
import type { GlobalLink } from "@/store/globalLinksStore";

/**
 * The Portal's link list while the dock lasts: its built-in chats, then the
 * person's global links (#17242), each group in its own order. The global
 * links keep their own ranks, so they are numbered on past the last built-in
 * one here, and one sort by `order` keeps both groups whole.
 */
export function withGlobalLinks(
  systemLinks: readonly PortalLink[],
  globalLinks: readonly GlobalLink[]
): PortalLink[] {
  const after = systemLinks.reduce((max, l) => Math.max(max, l.order), -1) + 1;
  return [
    ...systemLinks,
    ...globalLinks.map((link, index) => ({ ...link, type: "user" as const, order: after + index })),
  ];
}
