import { cn } from "../../lib/utils";
import { systemClient } from "@/clients/systemClient";
import { COUNT_BADGE_CLASS } from "@/components/ui/badge";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "@/components/ui/RowControl";
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
 * Never a focusable control: the badge lives inside a row that is itself a
 * `role="button"`, whose children are presentational, so a nested button would
 * be dropped or flattened by assistive tech and would add a tab stop to a list
 * that has exactly one. The row carries the meaning instead — its tooltip and
 * accessible description quote the provider's words, and a link is reached
 * from the keyboard through the row's context menu.
 *
 * A link badge is a pointer row control all the same: the shared 24px
 * `ROW_CONTROL_CLASS` target (given back with `-my-1`, so the row does not
 * grow) and a `RowControlTooltip` naming where it goes. It opens through
 * `systemClient.openExternal`, which applies the protocol allowlist — lesson
 * #9316 — so a provider can't reach `file://` / `javascript:`.
 */
export function FileDecorationBadge({ decoration, className }: FileDecorationBadgeProps) {
  const view = resolveFileDecoration(decoration);
  if (!view) return null;
  const { url } = view;

  if (!url) return <FileDecorationPill view={view} className={className} />;

  const destination = describeFileDecorationLink(view)?.[0];
  return (
    <RowControlTooltip
      label={
        <span className="flex flex-col gap-0.5">
          <span>{view.label}</span>
          {destination && <span className="text-text-secondary">{destination}</span>}
        </span>
      }
    >
      <span
        aria-hidden="true"
        data-file-decoration-link=""
        // Stop the click from bubbling to the row, which opens the diff on
        // click — a link badge opens its link and nothing else.
        onClick={(e) => {
          e.stopPropagation();
          void systemClient.openExternal(url);
        }}
        // A pointer move over the badge is the badge's, so the row's own path
        // tooltip is not asked to open beside this one. Radix already closes
        // any open tooltip when another opens; this keeps the row's from
        // reopening over it.
        onPointerMove={(e) => {
          if (e.pointerType !== "touch") e.stopPropagation();
        }}
        className={cn(ROW_CONTROL_CLASS, "group/decoration -my-1", className)}
      >
        {/* The neutral glyph steps up to primary with the hover, as a row
            control's icon does; a provider's own ink is left alone. */}
        <FileDecorationPill
          view={view}
          className={cn(
            !view.color &&
              "transition-[color] duration-150 ease-out group-hover/decoration:text-text-primary motion-reduce:transition-none"
          )}
        />
      </span>
    </RowControlTooltip>
  );
}
