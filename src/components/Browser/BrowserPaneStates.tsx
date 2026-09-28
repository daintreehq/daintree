import { AlertTriangle, ExternalLink, RotateCw, Square } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
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
    <div
      aria-live="assertive"
      aria-atomic="true"
      className="absolute top-0 left-0 right-0 z-20 flex items-center gap-2 px-3 py-1.5 text-xs bg-status-info/10 border-b border-status-info/30 text-text-primary"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-info" />
      <span className="truncate flex-1">
        Allow browser panel to load <span className="font-mono">{hostname}</span>?
      </span>
      <button
        type="button"
        onClick={onAllow}
        className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-info/20 hover:bg-status-info/30 text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      >
        Allow
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
        aria-label="Dismiss host approval"
      >
        ×
      </button>
    </div>
  );
}

export function BrowserNoUrlState({ onNavigate }: { onNavigate: (url: string) => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas text-text-primary p-6">
      <div className="flex flex-col items-center text-center max-w-md">
        <h3 className="text-sm font-medium text-text-secondary mb-1">Browser</h3>
        <p className="text-xs text-text-secondary mb-4 leading-relaxed">
          Preview your local development server. Enter a URL in the address bar above — localhost,
          LAN, Docker, and RFC-reserved TLDs (.local, .test, .internal) are all supported.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLE_HOSTS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onNavigate(`http://${example}`)}
              className="px-3 py-1.5 text-xs font-mono text-text-secondary bg-overlay-soft hover:bg-overlay-medium border border-overlay rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BrowserFirstViewPlaceholder() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas text-text-primary">
      <p className="text-xs text-text-secondary">
        Browser will load when this panel is first viewed
      </p>
    </div>
  );
}

export function BrowserEvictedPlaceholder() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas text-text-primary p-6">
      <p className="text-xs text-text-secondary">Reclaimed for memory</p>
    </div>
  );
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
    <div
      role="alert"
      className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-surface-canvas text-text-primary p-6"
    >
      <AlertTriangle className="w-6 h-6 text-status-warning mb-3" />
      <h3 className="text-sm font-medium text-text-secondary mb-1">
        {loadErrorTitle(loadError.kind)}
      </h3>
      <p className="text-xs text-text-secondary text-center mb-3 max-w-md">{loadError.message}</p>
      <div className="flex items-center gap-1">
        <Button onClick={onRetry} variant="ghost" size="sm" className="gap-1.5 px-2.5 py-1.5 group">
          <RotateCw className="h-3.5 w-3.5" />
          <span className="text-xs">Retry</span>
        </Button>
        <button
          type="button"
          onClick={onOpenExternal}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-overlay-soft transition-colors group focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        >
          <ExternalLink className="h-3.5 w-3.5 text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors" />
          <span className="text-xs text-text-secondary group-hover:text-text-primary transition-colors">
            Open in external browser
          </span>
        </button>
      </div>
    </div>
  );
}

export function BrowserBlockedNavNotice({
  hostname,
  canOpenExternal,
  opening,
  onOpenExternal,
  onDismiss,
}: {
  hostname: string;
  canOpenExternal: boolean;
  opening: boolean;
  onOpenExternal: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center gap-2 px-3 py-1.5 text-xs bg-status-warning/10 border-b border-status-warning/20 text-text-primary"
    >
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-status-warning" />
      <span className="truncate flex-1">Navigation to external site blocked: {hostname}</span>
      {canOpenExternal && (
        <button
          type="button"
          disabled={opening}
          aria-busy={opening || undefined}
          onClick={onOpenExternal}
          className="shrink-0 px-2 py-0.5 rounded text-xs bg-status-warning/20 hover:bg-status-warning/30 text-text-primary transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {opening ? "Opening…" : "Open in external browser"}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
        aria-label="Dismiss navigation notice"
      >
        ×
      </button>
    </div>
  );
}

export function BrowserLoadingOverlay({
  isSlowLoad,
  onCancel,
}: {
  isSlowLoad: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas z-10 gap-3">
      {/* The slow-load escalation announces via the sibling
          aria-live span below, never inside this status region
          (SkeletonHint pattern): nested live regions are spoken
          twice or not at all depending on the screen reader. */}
      <div role="status" aria-label="Loading…">
        <span className="sr-only">Loading…</span>
        <Spinner size="2xl" className="text-status-info" />
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {isSlowLoad ? "Loading is taking longer than usual. Select Cancel to stop." : ""}
      </span>
      {isSlowLoad && (
        <>
          <p aria-hidden="true" className="text-xs text-text-secondary">
            Taking longer than usual…
          </p>
          <Button
            onClick={onCancel}
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2.5 py-1.5 group text-text-secondary hover:text-text-primary"
          >
            <Square className="h-3.5 w-3.5" />
            <span className="text-xs">Cancel</span>
          </Button>
        </>
      )}
    </div>
  );
}
