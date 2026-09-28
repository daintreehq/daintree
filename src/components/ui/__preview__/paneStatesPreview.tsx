// First: the bridge stand-in must exist before any client module reads it.
import "@/components/DevPreview/__preview__/emptyStatesShims";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import type { FindInPageState } from "@/hooks/useFindInPage";
import {
  BrowserBlockedNavNotice,
  BrowserEvictedPlaceholder,
  BrowserFirstViewPlaceholder,
  BrowserHostApprovalBar,
  BrowserLoadErrorOverlay,
  BrowserLoadingOverlay,
  BrowserNoUrlState,
} from "@/components/Browser/BrowserPaneStates";
import { DevPreviewEmptyStates } from "@/components/DevPreview/DevPreviewEmptyStates";
import { DevPreviewWebviewOverlays } from "@/components/DevPreview/DevPreviewWebviewOverlays";
import type { BlockedNavState } from "@/components/DevPreview/BlockedNavBanner";
import type { WebviewLoadError } from "@/components/DevPreview/useDevPreviewLoadLifecycle";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import type { DevServerError } from "@shared/utils/devServerErrors";
import {
  TerminalBackendOverlay,
  TerminalStartupPlaceholder,
} from "@/components/Terminal/TerminalPane";
import { WorktreesReconnectingBadge } from "@/components/Sidebar/WorktreesReconnectingBadge";
import { StatusIcon } from "@/components/Setup/SystemToolsStep";
import { PluginViewLoadError } from "@/components/Plugin/PluginViewHost";
import "@/index.css";

/**
 * Standalone visual-review harness for pane-level loading, empty, placeholder
 * and error states.
 *
 * The point is comparison: the browser pane and the dev preview pane show the
 * same situations — a panel not yet viewed, a page evicted to save memory, a
 * page that failed to load, a page mid-load, a navigation blocked — so each row
 * mounts the REAL component for both, side by side, in boxes the size of a grid
 * pane. Further rows put the other "reconnecting", startup and inline busy
 * marks beside each other.
 *
 * Every row carries `data-shot` for the capture spec.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-grid, var(--color-surface-canvas))";
document.body.style.margin = "0";

const noop = () => {};
const PANE_W = 440;
const PANE_H = 300;
const DEV_URL = "http://localhost:5173/";

class ShotBoundary extends Component<{ name: string; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn(`[${this.props.name}]`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div data-shot-error={this.props.name} className="text-status-error text-xs p-2">
          {this.props.name}: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

function Pane({
  label,
  width = PANE_W,
  height = PANE_H,
  children,
}: {
  label: string;
  width?: number;
  height?: number;
  children: ReactNode;
}) {
  return (
    <div data-frame className="shrink-0" style={{ width }}>
      <div className="text-3xs uppercase tracking-wider text-text-secondary mb-1">{label}</div>
      <div
        className="relative flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas"
        style={{ height }}
      >
        <ShotBoundary name={label}>{children}</ShotBoundary>
      </div>
    </div>
  );
}

function Row({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="p-4">
      <h2 className="mb-3 text-xs font-medium text-text-primary">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

function DevEmpty({
  status,
  hasBeenVisible = true,
  isEvicted = false,
  error = null,
}: {
  status: DevPreviewStatus;
  hasBeenVisible?: boolean;
  isEvicted?: boolean;
  error?: DevServerError | null;
}) {
  return (
    <DevPreviewEmptyStates
      isRestarting={false}
      status={status}
      isProxyUrlPending={false}
      error={error}
      handleRetry={noop}
      setDevPreviewConsoleOpen={noop}
      id="dev-preview-harness"
      currentUrl={status === "running" || error ? DEV_URL : ""}
      handleOpenExternal={noop}
      isUnconfigured={false}
      primaryCandidate={undefined}
      isAutoDetecting={false}
      attemptingCommand={null}
      isSettingsLoading={false}
      handleAutoDetect={async () => true}
      autoDetectFailedCommand={null}
      candidates={[]}
      handlePickCandidate={noop}
      handleOpenSettings={noop}
      commandInput=""
      setCommandInput={noop}
      handleSaveCommand={async () => undefined}
      commandInputError={null}
      isSavingCommand={false}
      saveCommandFailed={false}
      devCommand="npm run dev"
      handleStartFromRestored={noop}
      hasBeenVisible={hasBeenVisible}
      isEvicted={isEvicted}
    />
  );
}

const FIND: FindInPageState = {
  isOpen: false,
  query: "",
  activeMatch: 0,
  matchCount: 0,
  matchCase: false,
  inputRef: { current: null },
  isComposingRef: { current: false },
  open: noop,
  close: noop,
  setQuery: noop,
  goNext: noop,
  goPrev: noop,
  toggleMatchCase: noop,
};

function DevOverlays({
  reconnectAttempt = 0,
  webviewLoadError = null,
  isLoading = false,
  blockedNav = null,
}: {
  reconnectAttempt?: number;
  webviewLoadError?: WebviewLoadError | null;
  isLoading?: boolean;
  blockedNav?: BlockedNavState | null;
}) {
  return (
    <DevPreviewWebviewOverlays
      reconnectAttempt={reconnectAttempt}
      webviewLoadError={webviewLoadError}
      certCopied={false}
      onCopyMkcert={noop}
      isRestarting={false}
      onRestartDevServer={noop}
      onHardReload={noop}
      onRequestRestartAndClearCache={noop}
      onRequestReinstallAndRestart={noop}
      onRetryWebviewLoad={noop}
      currentUrl={DEV_URL}
      onOpenExternal={noop}
      blockedNav={blockedNav}
      panelId="dev-preview-harness"
      webviewElement={null}
      onDispatchBlockedNav={noop}
      crashState="none"
      crashDetails={null}
      onCloseCrash={noop}
      onCloseUnresponsive={noop}
      isLoading={isLoading}
      onCancelLoad={noop}
      showRecoverySpinner={false}
      isRecoveringFromEviction={false}
      isDragging={false}
      findInPage={FIND}
      currentDialog={null}
      onDialogRespond={noop}
    >
      <div className="relative flex-1 min-h-0" />
    </DevPreviewWebviewOverlays>
  );
}

function blockedState(): BlockedNavState {
  return {
    notice: Symbol("harness"),
    url: "https://docs.stripe.com/payments/checkout",
    canOpenExternal: true,
    sessionStorageSnapshot: [],
    isOAuth: false,
    phase: "blocked",
    errorCause: null,
    errorMessage: null,
    openFailed: false,
    copyFeedback: null,
  };
}

const BLOCKED = blockedState();
const ESCALATED_AT = Date.now() - 42_000;

function HeaderBox({ children }: { children: ReactNode }) {
  return (
    <div className="@container/header flex w-72 items-baseline gap-1.5 rounded-[var(--radius-md)] border border-border-default bg-surface-sidebar px-3 py-2">
      <h2 className="truncate text-text-primary font-semibold text-sm tracking-wide">Worktrees</h2>
      {children}
    </div>
  );
}

function Harness() {
  return (
    <div className="w-[1440px]">
      <Row shot="first-view" title="Not yet viewed — browser | dev preview">
        <Pane label="Browser">
          <BrowserFirstViewPlaceholder />
        </Pane>
        <Pane label="Dev preview">
          <DevEmpty status="running" hasBeenVisible={false} />
        </Pane>
      </Row>
      <Row shot="evicted" title="Evicted to save memory — browser | dev preview">
        <Pane label="Browser">
          <BrowserEvictedPlaceholder />
        </Pane>
        <Pane label="Dev preview">
          <DevEmpty status="running" isEvicted />
        </Pane>
      </Row>
      <Row
        shot="load-error"
        title="Load failed — browser page | dev preview page | dev preview server"
      >
        <Pane label="Browser">
          <BrowserLoadErrorOverlay
            loadError={{
              kind: "network",
              message: "net::ERR_CONNECTION_REFUSED — localhost:3000 refused the connection.",
            }}
            onRetry={noop}
            onOpenExternal={noop}
          />
        </Pane>
        <Pane label="Dev preview webview">
          <DevOverlays
            webviewLoadError={{
              code: "name_not_resolved",
              message: "The address couldn't be resolved. Check the URL and your network.",
            }}
          />
        </Pane>
        <Pane label="Dev preview server">
          <DevEmpty
            status="error"
            error={{ type: "unknown", message: "The dev server exited with code 1." }}
          />
        </Pane>
      </Row>
      <Row shot="loading" title="Loading — browser | browser slow | dev preview | terminal startup">
        <Pane label="Browser" width={330}>
          <BrowserLoadingOverlay isSlowLoad={false} onCancel={noop} />
        </Pane>
        <Pane label="Browser slow" width={330}>
          <BrowserLoadingOverlay isSlowLoad onCancel={noop} />
        </Pane>
        <Pane label="Dev preview" width={330}>
          <DevOverlays isLoading />
        </Pane>
        <Pane label="Terminal startup" width={330}>
          <TerminalStartupPlaceholder agentId="claude" />
        </Pane>
      </Row>
      <Row shot="empty" title="No URL / not configured — browser | dev preview">
        <Pane label="Browser">
          <BrowserNoUrlState onNavigate={noop} />
        </Pane>
        <Pane label="Dev preview">
          <DevEmpty status="stopped" />
        </Pane>
        <Pane label="Plugin view">
          <PluginViewLoadError
            pluginId="acme.charts"
            displayName="Charts"
            message="The plugin's view entry point couldn't be found."
          />
        </Pane>
      </Row>
      <Row
        shot="banners"
        title="Pane notices — browser approval | browser blocked | dev preview blocked"
      >
        <Pane label="Browser host approval" height={120}>
          <BrowserHostApprovalBar hostname="staging.acme.dev" onAllow={noop} onDismiss={noop} />
        </Pane>
        <Pane label="Browser blocked nav" height={120}>
          <BrowserBlockedNavNotice
            hostname="docs.stripe.com"
            canOpenExternal
            opening={false}
            onOpenExternal={noop}
            onDismiss={noop}
          />
        </Pane>
        <Pane label="Dev preview blocked nav" height={120}>
          <DevOverlays blockedNav={BLOCKED} />
        </Pane>
      </Row>
      <Row shot="reconnecting" title="Reconnecting — dev preview | terminal | sidebar">
        <Pane label="Dev preview" width={360} height={200}>
          <DevOverlays reconnectAttempt={2} />
        </Pane>
        <Pane label="Terminal" width={360} height={200}>
          <div className="relative flex-1 bg-surface-canvas p-3 font-mono text-xs text-text-primary">
            $ npm run dev
            <TerminalBackendOverlay recovering />
          </div>
        </Pane>
        <div data-frame className="flex flex-col gap-3">
          <div className="text-3xs uppercase tracking-wider text-text-secondary">Sidebar</div>
          <HeaderBox>
            <WorktreesReconnectingBadge escalatedSince={null} />
          </HeaderBox>
          <HeaderBox>
            <WorktreesReconnectingBadge escalatedSince={ESCALATED_AT} />
          </HeaderBox>
        </div>
      </Row>
      <Row shot="inline-busy" title="Inline busy marks">
        <div
          data-frame
          className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border-default bg-surface-panel px-3 py-2 text-xs text-text-secondary"
        >
          <StatusIcon check={null} loading />
          <span>Checking git…</span>
        </div>
      </Row>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
    >
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
