import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { Button } from "@/components/ui/button";
import {
  SurfaceHeader,
  SurfaceHeaderCloseButton,
  SurfaceHeaderTitle,
} from "@/components/ui/SurfaceHeader";
import { HelpPanelHeader } from "@/components/HelpPanel/HelpPanelHeader";
import { HelpIntroBanner } from "@/components/HelpPanel/HelpIntroBanner";
import { FileEditorHintBar } from "@/components/FileViewer/FileEditorHintBar";
import { GettingStartedChecklist } from "@/components/Onboarding/GettingStartedChecklist";
import { GridNotificationBar } from "@/components/Terminal/GridNotificationBar";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { LogEntry } from "@/components/Logs/LogEntry";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { WorkspaceRootSidebar } from "@/components/Sidebar/WorkspaceRootSidebar";
import { useNotificationStore } from "@/store/notificationStore";
import "@/index.css";

/**
 * Standalone visual-review harness for the app's small close, dismiss and copy
 * icon buttons.
 *
 * The point of the page is comparison: every family is mounted side by side from
 * the REAL components, so a size, radius, hover or tick that differs between two
 * controls doing the same job is visible in one frame. Each row carries
 * `data-shot` for the capture spec, and every interesting button carries
 * `data-probe` so the spec can hover or focus it.
 *
 * Sections:
 *   surface-close   the full-surface close (SurfaceHeader) beside the panel-chrome reference
 *   headers         the assistant panel header and a workspace sidebar header
 *   dismiss         banner and card dismiss X's
 *   copy            copy buttons beside a payload
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

installPreviewShims();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => {};

useNotificationStore.getState().addNotification({
  type: "info",
  placement: "grid-bar",
  title: "Agent finished",
  message: "claude in feature/login-flow is waiting for review",
  duration: 0,
});

const DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 3b18e51..a9f2c7d 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -12,7 +12,8 @@ export function createSession(user: User) {
   const expires = Date.now() + SESSION_TTL_MS;
-  return { user, expires };
+  const token = randomToken();
+  return { user, expires, token };
 }
`;

class ShotBoundary extends Component<{ name: string; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.name}]`, error, info.componentStack);
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

function Label({ children }: { children: ReactNode }) {
  return <div className="text-3xs uppercase tracking-wider text-text-secondary mb-1">{children}</div>;
}

function Frame({ label, width, children }: { label: string; width?: number; children: ReactNode }) {
  return (
    <div data-frame style={width ? { width } : undefined} className="shrink-0 p-1">
      <Label>{label}</Label>
      <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-panel overflow-hidden">
        <ShotBoundary name={label}>{children}</ShotBoundary>
      </div>
    </div>
  );
}

function Section({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="p-4 flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-text-primary">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

function Preview() {
  return (
    <div className="flex flex-col gap-2 w-[1180px]">
      <Section shot="surface-close" title="Surface close">
        <Frame label="SurfaceHeader (AppDialog)" width={420}>
          <SurfaceHeader>
            <SurfaceHeaderTitle>Plugin settings</SurfaceHeaderTitle>
            <SurfaceHeaderCloseButton aria-label="Close settings" data-probe="surface-close" />
          </SurfaceHeader>
        </Frame>
        <Frame label="Artifacts header (Button icon-sm)" width={420}>
          <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 bg-surface-canvas">
            <h2 className="flex-1 text-sm font-medium text-text-primary">Artifacts 3</h2>
            <Button variant="ghost" size="sm">
              Clear
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close artifacts">
              <X />
            </Button>
          </div>
        </Frame>
      </Section>

      <Section shot="headers" title="Panel and sidebar headers">
        <Frame label="Assistant panel header" width={360}>
          <HelpPanelHeader
            agentState="idle"
            canRestartConversation
            canEndSession
            onRestartConversation={noop}
            onEndSession={noop}
            onOpenDocs={noop}
            onClose={noop}
          />
          <HelpIntroBanner onDismiss={noop} />
        </Frame>
        <Frame label="Workspace sidebar (no worktrees)" width={280}>
          <div style={{ height: 180 }}>
            <WorkspaceRootSidebar
              workspace={{
                kind: "scratch",
                id: "scratch-1",
                path: "/Users/avery/.daintree/scratch/notes",
                name: "Scratch notes",
                isGitBacked: false,
              }}
              homeDir="/Users/avery"
            />
          </div>
        </Frame>
      </Section>

      <Section shot="dismiss" title="Dismiss">
        <Frame label="File editor hint bar" width={560}>
          <FileEditorHintBar
            pluginName="Markdown Editor"
            state="ready"
            pending={false}
            error={null}
            onAction={noop}
            onDismiss={noop}
          />
        </Frame>
        <Frame label="Grid notification bar" width={760}>
          <div className="@container/banner">
            <GridNotificationBar />
          </div>
        </Frame>
      </Section>

      <Section shot="copy" title="Copy">
        <Frame label="Setup command" width={420}>
          <div className="p-3">
            <CopyableCommand
              command="npm install -g @anthropic-ai/claude-code"
              inspectUrl="https://example.com/install.sh"
            />
          </div>
        </Frame>
        <Frame label="Log entry" width={560}>
          <div className="group">
            <LogEntry
              entry={{
                id: "log-1",
                timestamp: new Date(2026, 8, 28, 9, 41, 12).getTime(),
                level: "warn",
                message: "Worktree poll took 2.4s — falling back to slow cadence",
                source: "WorkspaceService",
              }}
              isExpanded={false}
              onToggle={noop}
            />
          </div>
        </Frame>
        <Frame label="Diff file header + hunk" width={760}>
          <DiffViewer diff={DIFF} rootPath="/Users/avery/code/app" />
        </Frame>
      </Section>

      {/* Portals itself to the bottom-right corner, as it does in the app. */}
      <GettingStartedChecklist
        checklist={{
          dismissed: false,
          celebrationShown: false,
          items: {
            openedProject: true,
            launchedAgent: true,
            createdWorktree: false,
            ranSecondParallelAgent: false,
          },
        }}
        collapsed={false}
        onDismiss={noop}
        onToggleCollapse={noop}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
    >
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
