import { SquareTerminal, Globe, MonitorPlay } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import type { PanelKind } from "@/types";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { resolveTerminalRunIcon } from "./terminalRunIconRegistry";
import type { ReactNode } from "react";

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

  // Browser panes get a globe icon
  if (kind === "browser" || resolvedChrome.iconId === "globe") {
    return withIconMarker(
      <Globe {...finalProps} className={cn(finalProps.className, "text-status-info")} />
    );
  }

  // Dev preview panes get a monitor-play icon
  if (
    kind === "dev-preview" ||
    resolvedChrome.iconId === "monitor-play" ||
    resolvedChrome.iconId === "monitor"
  ) {
    return withIconMarker(
      <MonitorPlay {...finalProps} className={cn(finalProps.className, "text-status-info")} />
    );
  }

  const RunIcon = resolveTerminalRunIcon(resolvedChrome.iconId);
  if (RunIcon) {
    return withIconMarker(
      <RunIcon {...finalProps} brandColor={brandColor ?? resolvedChrome.color} />
    );
  }

  // Fallback to generic terminal icon
  return withIconMarker(<SquareTerminal {...finalProps} />, "terminal");
}
