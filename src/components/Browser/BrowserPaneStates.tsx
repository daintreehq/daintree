import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Globe, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanePlaceholder, PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { PaneLoadingState } from "@/components/ui/PaneLoadingState";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import type { LoadError } from "./browserUtils";

const EXAMPLE_HOSTS = ["localhost:3000", "localhost:5173", "localhost:8080"];

export function BrowserHostApprovalBar({
  hostname,
  onAllow,
  onDismiss,
}: {
  hostname: string;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="absolute top-0 left-0 right-0 z-20">
      <InlineStatusBanner
        severity="info"
        title={
          <>
            Allow browser panel to load <span className="font-mono">{hostname}</span>?
          </>
        }
        action={{ id: "allow-host", label: "Allow", variant: "primary", onClick: onAllow }}
        onClose={onDismiss}
        closeAriaLabel="Dismiss host approval"
        animated={false}
        role="alert"
        ariaLive="assertive"
      />
    </div>
  );
}

export function BrowserNoUrlState({ onNavigate }: { onNavigate: (url: string) => void }) {
  return (
    <PaneState
      icon={<Globe />}
      title="Enter a URL to preview it here"
      description="Localhost, LAN and Docker addresses all work, as do .local, .test and .internal hosts."
    >
      <PaneStateActions>
        {EXAMPLE_HOSTS.map((example) => (
          <Button
            key={example}
            variant="outline"
            size="sm"
            className="font-mono"
            onClick={() => onNavigate(`http://${example}`)}
          >
            {example}
          </Button>
        ))}
      </PaneStateActions>
    </PaneState>
  );
}

export function BrowserFirstViewPlaceholder() {
  return <PanePlaceholder>Browser will load when this panel is first viewed</PanePlaceholder>;
}

export function BrowserEvictedPlaceholder() {
  return <PanePlaceholder>Browser paused to save memory — will reload when opened</PanePlaceholder>;
}

function loadErrorTitle(kind: LoadError["kind"]): string {
  return kind === "timeout"
    ? "Page load timed out"
    : kind === "cancelled"
      ? "Load cancelled"
      : kind === "cert"
        ? "Certificate error"
        : kind === "network"
          ? "Connection failed"
          : "Unable to display page";
}

export function BrowserLoadErrorOverlay({
  loadError,
  onRetry,
  onOpenExternal,
}: {
  loadError: LoadError;
  onRetry: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <PaneState
      live="alert"
      className="z-30"
      icon={<AlertTriangle className="text-status-warning" />}
      title={loadErrorTitle(loadError.kind)}
      description={loadError.message}
    >
      <PaneStateActions>
        <Button onClick={onRetry} variant="subtle" size="sm">
          <RefreshCw />
          Retry
        </Button>
        <Button onClick={onOpenExternal} variant="ghost" size="sm">
          <ExternalLink />
          Open in external browser
        </Button>
      </PaneStateActions>
    </PaneState>
  );
}

// How long "Copied" lingers — the dev preview's notice uses the same beat. A
// failed copy stays until the notice goes: it may be the only way forward.
const COPY_FEEDBACK_MS = 2000;

/**
 * Same notice as the dev preview's blocked-navigation banner: the host in the
 * title, the full address beneath it, opening elsewhere as the way out and
 * copying the address beside it (or instead of it, when nothing can open it).
 * Mount it keyed by notice so a new block starts with fresh copy feedback.
 */
export function BrowserBlockedNavNotice({
  url,
  hostname,
  canOpenExternal,
  opening,
  onOpenExternal,
  onDismiss,
}: {
  url: string;
  hostname: string;
  canOpenExternal: boolean;
  opening: boolean;
  onOpenExternal: () => void;
  onDismiss: () => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "copy-failed" | null>(null);

  useEffect(() => {
    if (copyFeedback !== "copied") return;
    const timer = setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyFeedback]);

  const handleCopy = async () => {
    try {
      await window.electron.clipboard.writeText(url);
      setCopyFeedback("copied");
    } catch {
      setCopyFeedback("copy-failed");
    }
  };

  const copyAction: BannerAction = {
    id: "copy-url",
    label:
      copyFeedback === "copied"
        ? "Copied"
        : copyFeedback === "copy-failed"
          ? "Couldn't copy"
          : "Copy URL",
    icon: copyFeedback === "copied" ? Check : Copy,
    onClick: () => void handleCopy(),
    variant: canOpenExternal ? "dismiss" : "primary",
  };

  return (
    <InlineStatusBanner
      icon={ExternalLink}
      severity="warning"
      title={hostname ? `Can't open ${hostname} here` : "Can't open this link here"}
      contextLine={url}
      actions={[
        ...(canOpenExternal
          ? [
              {
                id: "open-external",
                label: opening ? "Opening…" : "Open in external browser",
                icon: ExternalLink,
                variant: "primary" as const,
                loading: opening,
                disabled: opening,
                onClick: onOpenExternal,
              },
            ]
          : []),
        copyAction,
      ]}
      onClose={onDismiss}
      closeAriaLabel="Dismiss navigation notice"
      animated={false}
      role="status"
      ariaLive="polite"
    />
  );
}

export function BrowserLoadingOverlay({
  isLoading,
  onCancel,
}: {
  isLoading: boolean;
  onCancel: () => void;
}) {
  return (
    <PaneLoadingState
      variant="overlay"
      isLoading={isLoading}
      phaseLabel="Loading page"
      onCancel={onCancel}
    />
  );
}
