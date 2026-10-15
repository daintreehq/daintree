import { cn } from "../../lib/utils";
import { systemClient } from "@/clients/systemClient";
import { COUNT_BADGE_CLASS } from "@/components/ui/badge";
import type { FileDecoration } from "@shared/types/forge";

/**
 * A provider decoration reduced to what a row renders: the glyph, the words
 * that explain it, and the link if there is one. `null` unless the provider
 * attached a non-empty `badge`, so a list can resolve every row through this
 * and only the decorated ones draw anything.
 */
export interface FileDecorationView {
  badge: string;
  /** The provider's `tooltip`, or the glyph itself when it gave none. */
  label: string;
  color: string | undefined;
  url: string | null;
  /** The link's host, for saying where a click goes; `null` when unparseable. */
  host: string | null;
}

export function resolveFileDecoration(
  decoration: FileDecoration | undefined
): FileDecorationView | null {
  const badge = decoration?.badge;
  if (typeof badge !== "string" || badge.length === 0) return null;
  const url =
    typeof decoration?.url === "string" && decoration.url.length > 0 ? decoration.url : null;
  let host: string | null = null;
  if (url) {
    try {
      host = new URL(url).hostname || null;
    } catch {
      host = null;
    }
  }
  return { badge, label: decoration?.tooltip ?? badge, color: decoration?.color, url, host };
}

/**
 * Where a link badge goes, then both ways to get there. Names the badge,
 * because these lines ride the row's tooltip and a click anywhere else on the
 * row opens the diff; names the menu chord, because the badge itself takes no
 * focus and the same tooltip opens on keyboard focus.
 */
export function describeFileDecorationLink(
  view: FileDecorationView
): readonly [destination: string, route: string] | null {
  if (!view.url) return null;
  return [
    view.host ? `Opens ${view.host} in your browser` : "Opens in your browser",
    "Click the badge, or open the menu with Shift+F10",
  ];
}

interface FileDecorationPillProps {
  view: FileDecorationView;
  className?: string;
}

/**
 * The glyph itself, in the app's shared count pill so a plugin's tally reads
 * the same as every other count. Provider `color` is an opaque class appended
 * after the neutral default so it can override it (per the
 * `FileDecoration.color` contract); absent it, the neutral tint keeps the badge
 * from being mistaken for the scarce accent.
 */
export function FileDecorationPill({ view, className }: FileDecorationPillProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        COUNT_BADGE_CLASS,
        // A link reads as one at rest, without spending width on a glyph the
        // badge column would have to reserve on every row.
        view.url && "underline decoration-1 underline-offset-[1.5px]",
        view.color,
        className
      )}
    >
      {view.badge}
    </span>
  );
}

interface FileDecorationBadgeProps {
  decoration: FileDecoration | undefined;
  className?: string;
}

/**
 * Renders a single plugin-contributed {@link FileDecoration} badge for a file
 * row — the general, non-Review-Hub counterpart to the bespoke unresolved-
 * comment badge in `ReviewHubContent`. The host knows nothing about what a
 * decoration means: the plugin authors the `badge` glyph, the `tooltip`, an
 * optional `color`, and an optional `url` click target.
 *
 * Presentation only, by design: the badge lives inside a row that is itself a
 * `role="button"`, whose children are presentational, so a nested button would
 * be dropped or flattened by assistive tech and would add a tab stop to a list
 * that has exactly one. The row carries the meaning instead — its tooltip and
 * accessible description quote the provider's words, and a link is reached
 * from the keyboard through the row's context menu. Pointer users still click
 * a link badge directly: it opens through `systemClient.openExternal` (which
 * applies the protocol allowlist — lesson #9316 — so a provider can't reach
 * `file://` / `javascript:`), across a 24px target that gives back its extra
 * height so the row does not grow.
 */
export function FileDecorationBadge({ decoration, className }: FileDecorationBadgeProps) {
  const view = resolveFileDecoration(decoration);
  if (!view) return null;
  const { url } = view;

  if (!url) return <FileDecorationPill view={view} className={className} />;

  return (
    <span
      aria-hidden="true"
      data-file-decoration-link=""
      // Stop the click from bubbling to the row, which opens the diff on
      // click — a link badge opens its link and nothing else.
      onClick={(e) => {
        e.stopPropagation();
        void systemClient.openExternal(url);
      }}
      className={cn(
        "group/decoration -my-1 inline-flex h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center",
        className
      )}
    >
      {/* The hover wash is a layer between the pill's fill and its glyph
          rather than a new fill, so a provider's own colour survives it. The
          neutral glyph steps up to primary with it, as row controls do; a
          provider's own ink is left alone. */}
      <FileDecorationPill
        view={view}
        className={cn(
          "relative isolate after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:rounded-full after:bg-overlay-hover after:opacity-0 after:transition-opacity after:duration-150 after:ease-out group-hover/decoration:after:opacity-100 motion-reduce:after:transition-none",
          !view.color &&
            "transition-[color] duration-150 ease-out group-hover/decoration:text-text-primary motion-reduce:transition-none"
        )}
      />
    </span>
  );
}
