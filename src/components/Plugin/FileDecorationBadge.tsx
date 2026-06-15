import { cn } from "../../lib/utils";
import { systemClient } from "@/clients/systemClient";
import type { FileDecoration } from "@shared/types/forge";

interface FileDecorationBadgeProps {
  decoration: FileDecoration | undefined;
  className?: string;
}

/**
 * Renders a single plugin-contributed {@link FileDecoration} badge for a file
 * row — the general, non-Review-Hub counterpart to the bespoke unresolved-
 * comment badge in `ReviewHubContent`. The host knows nothing about what a
 * decoration means: the plugin authors the `badge` glyph, the `tooltip`
 * (accessible label), an optional `color`, and an optional `url` click target.
 *
 * Renders nothing unless the provider attached a non-empty `badge`, so a file
 * list can drop this in for every row and it stays invisible until a plugin
 * actually decorates that path. When a `url` is present the badge becomes a
 * button that opens it through `systemClient.openExternal` (which applies the
 * protocol allowlist — lesson #9316 — so a provider can't reach `file://` /
 * `javascript:`); otherwise it is a static, non-interactive marker.
 */
export function FileDecorationBadge({ decoration, className }: FileDecorationBadgeProps) {
  const badge = decoration?.badge;
  if (typeof badge !== "string" || badge.length === 0) return null;

  const label = decoration?.tooltip ?? badge;
  const url =
    typeof decoration?.url === "string" && decoration.url.length > 0 ? decoration.url : null;
  // Provider-authored color is opt-in; fall back to a neutral muted surface so
  // a decoration without an explicit color is never mistaken for the scarce
  // accent (CLAUDE.md accent-restraint rule).
  const style = decoration?.color ? { color: decoration.color } : undefined;

  const shared = cn(
    "shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full",
    "text-[10px] font-semibold tabular-nums",
    "bg-overlay-subtle text-daintree-text/80",
    className
  );

  if (url) {
    return (
      <button
        type="button"
        onClick={() => void systemClient.openExternal(url)}
        aria-label={label}
        style={style}
        className={cn(
          shared,
          "hover:bg-tint/10 transition-colors cursor-pointer",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
        )}
      >
        {badge}
      </button>
    );
  }

  return (
    <span aria-label={label} title={label} style={style} className={shared}>
      {badge}
    </span>
  );
}
