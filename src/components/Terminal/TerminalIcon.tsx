import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/icons";
import {
  DEFAULT_PANEL_ICON,
  getPluginIconComponent,
  PLUGIN_ICON_COMPONENTS,
  PLUGIN_ICON_IDS,
  type PluginIconId,
} from "@/components/icons/pluginIconRegistry";
import type { PanelKind } from "@/types";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { resolveTerminalRunIcon } from "./terminalRunIconRegistry";
import type { ReactNode } from "react";

/** Built-in panel kinds pin their glyph regardless of the chrome's `iconId`. */
const KIND_ICON_ID: Partial<Record<PanelKind, PluginIconId>> = {
  browser: "globe",
  "dev-preview": "monitor-play",
  review: "git-pull-request",
  file: "file-text",
  diff: "file-diff",
  "file-browser": "folder-tree",
};

/**
 * Ids that carry a category color in panel chrome. Everything else in the
 * registry renders neutral — the color is the panel-kind signal, not the icon.
 */
const SEMANTIC_ICON_CLASS: Partial<Record<PluginIconId, string>> = {
  globe: "text-status-info",
  monitor: "text-status-info",
  "monitor-play": "text-status-info",
  "git-pull-request": "text-category-violet",
  "file-text": "text-category-amber",
  "file-diff": "text-category-green",
  "folder-tree": "text-category-cyan",
};

/**
 * Narrows a manifest-supplied id to one that carries a category color.
 * `Object.hasOwn` rather than `in`: `iconId` is untrusted manifest input, and
 * `in` would match inherited keys like `toString`.
 */
function semanticId(iconId: string | null | undefined): PluginIconId | undefined {
  if (!iconId || !Object.hasOwn(SEMANTIC_ICON_CLASS, iconId)) return undefined;
  return PLUGIN_ICON_IDS.find((id) => id === iconId);
}

export interface TerminalIconProps {
  kind?: PanelKind;
  chrome?: TerminalChromeDescriptor;
  className?: string;
  brandColor?: string;
}

export function TerminalIcon({ kind, chrome, className, brandColor }: TerminalIconProps) {
  const resolvedChrome = chrome ?? deriveTerminalChrome({ kind });
  const iconId = resolvedChrome.iconId ?? "terminal";
  const finalProps = {
    className: cn("w-4 h-4", className),
    "aria-hidden": "true" as const,
  };

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !(window as Window & { __DAINTREE_IDENTITY_RENDER_DEBUG__?: boolean })
        .__DAINTREE_IDENTITY_RENDER_DEBUG__
    ) {
      return;
    }
    // DevTools-only diagnostic gated by the `__DAINTREE_IDENTITY_RENDER_DEBUG__`
    // runtime flag; bypasses the IPC logger so devs can see the trail in-page.
    // eslint-disable-next-line no-console
    console.debug(
      `[IdentityDebug] render-icon kind=${kind ?? "<none>"} icon=${iconId} ` +
        `agent=${resolvedChrome.agentId ?? "<none>"} process=${resolvedChrome.processId ?? "<none>"} ` +
        `label=${resolvedChrome.label}`
    );
  }, [kind, iconId, resolvedChrome.agentId, resolvedChrome.processId, resolvedChrome.label]);

  const markerColor = brandColor ?? resolvedChrome.color;
  const withIconMarker = (icon: ReactNode, markerIconId = iconId) => (
    <span
      className="contents"
      data-terminal-icon-id={markerIconId}
      data-terminal-icon-color={markerColor}
    >
      {icon}
    </span>
  );

  // A built-in kind pins its glyph; otherwise the chrome's own id selects one.
  // Both resolve through the shared registry, so an id renders the same glyph
  // here as it does in the panel palette.
  const semanticIconId =
    (kind ? KIND_ICON_ID[kind] : undefined) ?? semanticId(resolvedChrome.iconId);
  if (semanticIconId) {
    const SemanticIcon = PLUGIN_ICON_COMPONENTS[semanticIconId];
    return withIconMarker(
      <SemanticIcon
        {...finalProps}
        className={cn(finalProps.className, SEMANTIC_ICON_CLASS[semanticIconId])}
      />
    );
  }

  const RunIcon = resolveTerminalRunIcon(resolvedChrome.iconId);
  if (RunIcon) {
    return withIconMarker(
      <BrandMark brandColor={markerColor} className={finalProps.className}>
        <RunIcon {...finalProps} />
      </BrandMark>
    );
  }

  // Any other registered id renders neutrally — this is what plugin-contributed
  // panels reach, and it's why `puzzle`/`git-branch`/`sticky-note` no longer
  // fall through to the terminal glyph the way the old id conditionals did.
  const RegisteredIcon = getPluginIconComponent(resolvedChrome.iconId);
  if (RegisteredIcon) {
    return withIconMarker(<RegisteredIcon {...finalProps} />);
  }

  // Fallback to generic terminal icon
  const FallbackIcon = DEFAULT_PANEL_ICON;
  return withIconMarker(<FallbackIcon {...finalProps} />, "terminal");
}
