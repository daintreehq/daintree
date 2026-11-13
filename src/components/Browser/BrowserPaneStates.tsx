import { useState, type Ref } from "react";
import { Check, Copy, ExternalLink, Globe, Info, RefreshCw, RotateCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { COPIED_LABEL, COPY_FAILED_LABEL } from "@/components/ui/CopyButton";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { writeMainClipboard } from "@/lib/mainClipboard";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  PanePlaceholder,
  PaneState,
  PaneStateActions,
  withInlineCode,
} from "@/components/ui/PaneState";
import { PaneLoadingState } from "@/components/ui/PaneLoadingState";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { STOPPED_LOAD_TITLE, type LoadError } from "./browserUtils";

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
    // Above the load-error overlay (z-30): leaving a failed page for a new
    // host is exactly when this prompt shows, and beneath that overlay it can
    // be neither seen nor clicked.
    <div className="absolute top-0 left-0 right-0 z-40">
      <InlineStatusBanner
        severity="info"
        title={
          <>
            Allow browser panel to load <span className="font-mono">{hostname}</span>?
          </>
        }
        description="Applies to every Browser panel in this project, and stays allowed"
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
      ? STOPPED_LOAD_TITLE
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
  stoppedActionRef,
}: {
  loadError: LoadError;
  onRetry: () => void;
  onOpenExternal: () => void;
  /** Takes focus when the loading overlay's Cancel unmounted under it. */
  stoppedActionRef?: Ref<HTMLButtonElement>;
}) {
  // A load the user stopped is not a failure: the neutral mark, a polite status,
  // and Reload rather than Retry.
  const stopped = loadError.kind === "cancelled";
  return (
    <PaneState
      live={stopped ? "status" : "alert"}
      announceAfterMount={stopped}
      className="z-30"
      icon={
        stopped ? (
          <Info className="text-text-secondary" />
        ) : (
          <XCircle className="text-status-error" />
        )
      }
      title={loadErrorTitle(loadError.kind)}
      description={withInlineCode(loadError.message)}
    >
      <PaneStateActions>
        {stopped ? (
          <Button ref={stoppedActionRef} onClick={onRetry} variant="outline" size="sm">
            <RotateCw />
            Reload
          </Button>
        ) : (
          <Button onClick={onRetry} variant="outline" size="sm">
            <RefreshCw />
            Retry
          </Button>
        )}
        <Button onClick={onOpenExternal} variant="ghost" size="sm">
          <ExternalLink />
          Open in external browser
        </Button>
      </PaneStateActions>
    </PaneState>
  );
}

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
  // The shared dwell and announcement; the main-process clipboard, since the
  // guest page may hold focus. A failed copy stays until the notice goes: it
  // may be the only way forward.
  const { copiedText, copy } = useCopyWithFeedback({ write: writeMainClipboard });
  const [copyFailed, setCopyFailed] = useState(false);
  const copied = copiedText === url;

  const handleCopy = async () => {
    const ok = await copy(url);
    setCopyFailed(!ok);
    if (!ok) useAnnouncerStore.getState().announce(COPY_FAILED_LABEL, "assertive");
  };

  const copyAction: BannerAction = {
    id: "copy-url",
    label: copied ? COPIED_LABEL : copyFailed ? COPY_FAILED_LABEL : "Copy URL",
    // Constant: the hook announces the copy, and a name that flips under focus
    // is announced a second time.
    ariaLabel: "Copy URL",
    icon: copied ? Check : Copy,
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
