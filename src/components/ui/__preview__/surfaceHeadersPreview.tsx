import {
  emitArtifactsDetected,
  FEATURE_BRANCH,
  FEATURE_PATH,
  REPO_ROOT,
} from "./surfaceHeadersShims";
import {
  Component,
  StrictMode,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { WorktreeSnapshot } from "@shared/types";
import type { PtyPanelData, ReviewPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getAgentConfig } from "@/config/agents";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { PanelDialogHost } from "@/components/Panel/PanelDialogHost";
import { TerminalScratchpad } from "@/components/Terminal/TerminalScratchpad";
import { ArtifactOverlay } from "@/components/Terminal/ArtifactOverlay";
import { FIXTURES as ARTIFACT_FIXTURES } from "@/components/Terminal/__preview__/artifactOverlayFixtures";
import { SCRATCHPAD_FIXTURES } from "@/components/Terminal/__preview__/scratchpadFixtures";
import { HelpPanelHeader } from "@/components/HelpPanel/HelpPanelHeader";
import { HelpSessionTabs, type HelpSessionTab } from "@/components/HelpPanel/HelpSessionTabs";
import { HelpPanelFooter } from "@/components/HelpPanel/HelpPanelFooter";
import { ThemeBrowser } from "@/components/ThemeBrowser/ThemeBrowser";
import { PluginManagerView } from "@/components/Plugin/PluginManagerView";
import { CrossWorktreeDiff } from "@/components/Worktree/CrossWorktreeDiff";
import { ReviewPane } from "@/panels/review/ReviewPane";
import { FileBrowserHiddenStrip } from "@/panels/file-browser/FileBrowserHiddenStrip";
import { ZoomableImage } from "@/components/FileViewer/ZoomableImage";
import { DiagnosticsPanel } from "@/components/DevPreview/DiagnosticsPanel";
import { SHOTS, isShotName, type ShotName } from "./surfaceHeadersShots";
import "@/index.css";

/**
 * Visual-review harness for the header bars and status footers of the app's
 * secondary surfaces, set beside the grid pane's compact `SurfaceHeader` they are
 * meant to be judged against.
 *
 * Every surface is the REAL component — or, where the product hosts it, its real
 * host (`ContentPanel`, `ReviewPane`, `PanelDialogHost`) — against the real theme
 * tokens and `index.css`. Data arrives the way the app delivers it: seeded stores,
 * and the shimmed bridge in `surfaceHeadersShims.ts` for what a surface reads over
 * IPC on mount. Stand-ins are limited to the bodies around a header or footer
 * (terminal lines, a tree, a transcript), there only to give it real neighbours.
 *
 * One shot per page load, because several of these are module-singleton stores or
 * full-window portals that cannot share a page:
 *
 *   ?shot=<name>    one of SHOTS in surfaceHeadersShots.ts
 *   ?theme=<id>     built-in theme id
 *
 * The frame is `data-testid="shot-<name>"` and gains `data-ready="true"` only once
 * the shot's `readyText` is on screen inside the surface, never from the caption.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const shotParam = params.get("shot") ?? "";
if (!isShotName(shotParam)) throw new Error(`Unknown shot "${shotParam}"`);
const shot: ShotName = shotParam;

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => {};

const PANE_ID = "surface-pane";
const FOOTER_SCRATCH_ID = "surface-footer-scratchpad";
const REVIEW_PANEL_ID = "surface-review";
const MAIN_ID = "wt-main";
const FEATURE_ID = "wt-feature-auth";

// ---------------------------------------------------------------------------------
// Store seeding — module scope, once per page, for the one shot on it
// ---------------------------------------------------------------------------------

function scratchpadRow(id: string, width?: number): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "auth-refresh",
    location: "grid",
    cwd: REPO_ROOT,
    cols: 120,
    rows: 40,
    scratchpad: { ...SCRATCHPAD_FIXTURES.notes.scratchpad, ...(width ? { width } : {}) },
  } as PtyPanelData;
}

usePluginContextMenuItemsStore.setState({ entries: [], init: noop });
useAppThemeStore.setState({ selectedSchemeId: themeId });

if (shot === "pane-unfocused" || shot === "pane-focused") {
  usePanelStore.setState({
    panelsById: { [PANE_ID]: scratchpadRow(PANE_ID) },
    panelIds: [PANE_ID],
    focusedId: shot === "pane-focused" ? PANE_ID : null,
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
}
if (shot === "footers") {
  usePanelStore.setState({
    panelsById: { [FOOTER_SCRATCH_ID]: scratchpadRow(FOOTER_SCRATCH_ID, 380) },
    panelIds: [FOOTER_SCRATCH_ID],
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
}
if (shot === "plugin-manager") {
  usePluginManagerStore.setState({ isOpen: true });
}
if (shot === "review-hub-grid" || shot === "review-hub-dialog") {
  initBuiltInPanelKinds();
  const row = {
    id: REVIEW_PANEL_ID,
    kind: "review",
    title: "Review & commit",
    location: shot === "review-hub-dialog" ? "dialog" : "grid",
    worktreeId: FEATURE_ID,
  } as ReviewPanelData;
  usePanelStore.setState({
    panelsById: { [REVIEW_PANEL_ID]: row },
    panelIds: shot === "review-hub-dialog" ? [] : [REVIEW_PANEL_ID],
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
  if (shot === "review-hub-dialog") {
    usePanelDialogStore.setState({ dialogStack: [REVIEW_PANEL_ID] });
  }
}

function worktree(
  id: string,
  path: string,
  branch: string,
  extra: Partial<WorktreeSnapshot>
): WorktreeSnapshot {
  return { id, worktreeId: id, path, name: branch, branch, isCurrent: false, ...extra };
}

/** The per-view worktree store only exists inside its provider, so it is seeded from there. */
function SeedWorktrees({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({
      worktrees: new Map<string, WorktreeSnapshot>([
        [MAIN_ID, worktree(MAIN_ID, REPO_ROOT, "main", { isMainWorktree: true, isCurrent: true })],
        [FEATURE_ID, worktree(FEATURE_ID, FEATURE_PATH, FEATURE_BRANCH, {})],
      ]),
    });
    return true;
  });
  return ready ? children : null;
}

// ---------------------------------------------------------------------------------
// Harness chrome
// ---------------------------------------------------------------------------------

class ShotBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    if (!(error instanceof Error)) return { error: String(error) };
    const frames = (error.stack ?? "").split("\n").slice(1, 4).join(" ← ");
    return { error: `${error.message} @ ${frames}` };
  }
  render() {
    if (this.state.error) {
      return (
        <div data-preview-error className="p-3 text-xs text-status-danger">
          Failed to render: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

function Frame({ children }: { children: ReactNode }) {
  const spec = SHOTS[shot];
  const bodyRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;
    const needles = "readyText" in spec ? spec.readyText : spec.expectText;
    let raf = 0;
    const tick = () => {
      // A portalled surface is judged where it actually renders, not in the frame.
      const root = spec.target === "frame" ? bodyRef.current : document.querySelector(spec.target);
      const text = root?.textContent ?? "";
      const failed = bodyRef.current?.querySelector("[data-preview-error]");
      if (!failed && root && needles.every((needle) => text.includes(needle))) {
        setReady(true);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, spec]);

  return (
    <div
      data-testid={`shot-${shot}`}
      data-ready={ready ? "true" : undefined}
      className="inline-flex flex-col gap-2 p-4 bg-surface-canvas"
    >
      <div className="font-mono text-2xs tracking-wide text-text-muted">
        {spec.label} · {themeId}
      </div>
      <div data-shot-body ref={bodyRef}>
        <ShotBoundary>{children}</ShotBoundary>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Stand-in bodies
// ---------------------------------------------------------------------------------

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div>$ npm test -- src/auth</div>
      <div className="text-text-muted">✓ refresh token rotates on expiry (41 ms)</div>
      <div className="text-text-muted">✓ rejects a replayed nonce (12 ms)</div>
      <div className="text-text-muted">✗ refresh races a cold cache (1.2 s)</div>
      <div>&nbsp;</div>
      <div>$ git status --short</div>
      <div className="text-text-muted"> M src/auth/session.ts</div>
      <div>$ ▍</div>
    </div>
  );
}

function TranscriptStandIn() {
  return (
    <div className="flex-1 min-h-0 px-3 py-3 space-y-2" aria-hidden="true">
      <div className="h-2 w-4/5 rounded-full bg-overlay-soft" />
      <div className="h-2 w-3/5 rounded-full bg-overlay-soft" />
      <div className="h-2 w-2/3 rounded-full bg-overlay-soft" />
      <div className="h-2 w-1/2 rounded-full bg-overlay-soft" />
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------

function GridPane({ focused }: { focused: boolean }) {
  return (
    <div className="bg-surface-grid p-2" style={{ width: 860, height: 380 }}>
      <ContentPanel
        id={PANE_ID}
        title="auth-refresh"
        kind="terminal"
        isFocused={focused}
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        onRestart={noop}
        onAddTab={noop}
      >
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0 bg-surface-canvas flex flex-col">
            <TerminalLines />
          </div>
          <TerminalScratchpad terminalId={PANE_ID} />
        </div>
      </ContentPanel>
    </div>
  );
}

function AssistantFooter() {
  const agentConfig = getAgentConfig("claude");
  if (!agentConfig) throw new Error("no agent config for claude");
  return (
    <HelpPanelFooter
      sessionId="preview-session"
      activity={null}
      outcomeAlert={null}
      onDismissOutcome={noop}
      terminalId={null}
      pinnedContext={{
        worktreeId: FEATURE_ID,
        worktreeName: FEATURE_BRANCH,
        worktreeBranch: FEATURE_BRANCH,
        terminalId: "t-1",
      }}
      isPinnedWorktreeDiverged={false}
      onReturnToPinnedWorktree={noop}
      agentId="claude"
      agentConfig={agentConfig}
      launchedModelLabel={null}
    />
  );
}

function AssistantColumn({ focused }: { focused: boolean }) {
  const [activeSlot, setActiveSlot] = useState(0);
  const idBase = useId();
  const bodyId = `${idBase}-body`;
  const tabs: HelpSessionTab[] = [
    { slot: 0, label: "Session 1", agentState: null },
    { slot: 1, label: "Session 2", agentState: "working" },
  ];
  return (
    <div className="flex bg-surface-grid" style={{ height: 520 }}>
      <aside
        className="relative shrink-0 flex flex-col h-full overflow-hidden bg-surface-canvas border-l border-border-default"
        style={{ width: 380 }}
      >
        <HelpPanelHeader
          agentState={tabs[activeSlot]?.agentState ?? null}
          canRestartConversation
          canEndSession
          onRestartConversation={noop}
          onEndSession={noop}
          onOpenDocs={noop}
          onClose={noop}
          isFocused={focused}
        />
        <HelpSessionTabs
          tabs={tabs}
          activeSlot={activeSlot}
          onSelect={setActiveSlot}
          onClose={noop}
          canOpenSession
          onOpenSession={noop}
          idBase={idBase}
          panelId={bodyId}
        />
        <div id={bodyId} className="flex-1 min-h-0 flex flex-col">
          <TranscriptStandIn />
        </div>
        <AssistantFooter />
      </aside>
    </div>
  );
}

const ARTIFACT_TERMINAL_ID = "surface-artifact-terminal";
// StrictMode replays effects and the artifact store appends — one delivery per load.
let artifactsSeeded = false;

function ArtifactPane({ fixture }: { fixture: "single-code" | "populated" }) {
  useEffect(() => {
    if (artifactsSeeded) return;
    artifactsSeeded = true;
    const delivered = emitArtifactsDetected({
      agentId: "claude",
      terminalId: ARTIFACT_TERMINAL_ID,
      worktreeId: FEATURE_ID,
      artifacts: ARTIFACT_FIXTURES[fixture]!,
      timestamp: Date.now(),
    });
    if (!delivered) throw new Error("useArtifacts never subscribed to artifact.onDetected");
  }, [fixture]);

  return (
    <div
      className="relative overflow-hidden border border-border-default"
      style={{ width: 760, height: 520, background: "var(--color-terminal-background)" }}
    >
      <pre
        className="absolute inset-0 m-0 p-2 font-mono text-sm leading-[1.35]"
        style={{ color: "var(--color-terminal-foreground)" }}
      >
        {[
          "⏺ Update(src/auth/session.ts)",
          "  ⎿  Updated src/auth/session.ts with 9 additions and 3 removals",
          "",
          "⏺ Done. Tests pass; the code and patches are below.",
          "",
          "> ",
        ].join("\n")}
      </pre>
      <ArtifactOverlay
        terminalId={ARTIFACT_TERMINAL_ID}
        worktreeId={FEATURE_ID}
        cwd={FEATURE_PATH}
      />
    </div>
  );
}

function ThemeBrowserShot() {
  return (
    // Right-hand room so the hovered close button's tooltip lands inside the frame.
    <div style={{ paddingRight: 140 }}>
      <div
        className="relative overflow-hidden border border-border-default"
        style={{ height: 340 }}
      >
        <ThemeBrowser />
      </div>
    </div>
  );
}

/** Keeps the frame mounted for surfaces that portal themselves out of it. */
function PortalNote({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="text-2xs text-text-muted">Rendered in a portal — see the target surface.</div>
      {children}
    </>
  );
}

function ReviewGrid() {
  return (
    <div className="flex flex-col bg-surface-grid p-2" style={{ width: 820, height: 460 }}>
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-divider">
        <ReviewPane id={REVIEW_PANEL_ID} worktreeId={FEATURE_ID} onClose={noop} location="grid" />
      </div>
    </div>
  );
}

// ---- Footers ----------------------------------------------------------------------

/** A 1600×900 PNG drawn once, so the image footer has real natural dimensions. */
function makeSampleImage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const gradient = ctx.createLinearGradient(0, 0, 1600, 900);
  gradient.addColorStop(0, "#2b5876");
  gradient.addColorStop(1, "#4e4376");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1600, 900);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(1180, 300, 140, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL("image/png");
}

/**
 * `ZoomableImage` loads through the app's `daintree-file://` protocol, which a
 * browser tab cannot resolve. Swapping the element's src after React wrote it keeps
 * the component's own `onLoad` in charge of the dimensions it reports.
 */
function ImageBlock() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const img = ref.current?.querySelector("img");
    if (img && img.src.startsWith("daintree-file:")) img.src = makeSampleImage();
  });
  return (
    <div ref={ref} className="flex flex-col bg-surface-canvas" style={{ width: 380, height: 220 }}>
      <ZoomableImage
        filePath={`${REPO_ROOT}/assets/hero.png`}
        rootPath={REPO_ROOT}
        alt="hero.png"
      />
    </div>
  );
}

function FooterBlock({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="font-mono text-2xs text-text-muted">{caption}</div>
      <div className="border border-border-default overflow-hidden" style={{ width: 380 }}>
        {children}
      </div>
    </div>
  );
}

function Footers() {
  return (
    <div className="flex flex-col gap-4">
      <FooterBlock caption="FileBrowserHiddenStrip">
        <div className="flex flex-col bg-surface-canvas" style={{ height: 120 }}>
          <div
            className="flex-1 px-2 py-1.5 text-xs leading-6 text-text-secondary"
            aria-hidden="true"
          >
            <div>▾ src</div>
            <div className="pl-4">session.ts</div>
            <div className="pl-4">tokens.ts</div>
          </div>
          <FileBrowserHiddenStrip counts={{ dotfiles: 7, alwaysHidden: 2 }} onShowDotfiles={noop} />
        </div>
      </FooterBlock>
      <FooterBlock caption="ZoomableImage status strip">
        <ImageBlock />
      </FooterBlock>
      <FooterBlock caption="TerminalScratchpad status footer">
        {/* The column caps itself at half its pane, so it sits in a 760px row and
            the frame shows only the column's 380px half. */}
        <div className="flex" style={{ width: 760, height: 200, marginLeft: -380 }}>
          <div className="flex-1 min-w-0 bg-surface-canvas" />
          <TerminalScratchpad terminalId={FOOTER_SCRATCH_ID} />
        </div>
      </FooterBlock>
      <FooterBlock caption="HelpPanelFooter">
        <div className="flex flex-col bg-surface-canvas" style={{ height: 110 }}>
          <TranscriptStandIn />
          <AssistantFooter />
        </div>
      </FooterBlock>
    </div>
  );
}

function Shot() {
  switch (shot) {
    case "pane-unfocused":
      return <GridPane focused={false} />;
    case "pane-focused":
      return <GridPane focused />;
    case "assistant-unfocused":
      return <AssistantColumn focused={false} />;
    case "assistant-focused":
      return <AssistantColumn focused />;
    case "artifact-overlay-single":
      return <ArtifactPane fixture="single-code" />;
    case "artifact-overlay-bulk":
      return <ArtifactPane fixture="populated" />;
    case "theme-browser":
    case "theme-browser-close-hover":
      return <ThemeBrowserShot />;
    case "plugin-manager":
      return (
        <PortalNote>
          <PluginManagerView />
        </PortalNote>
      );
    case "cross-worktree-diff":
      return (
        <PortalNote>
          <CrossWorktreeDiff isOpen onClose={noop} initialWorktreeId={FEATURE_ID} />
        </PortalNote>
      );
    case "review-hub-grid":
      return <ReviewGrid />;
    case "review-hub-dialog":
      return (
        <PortalNote>
          <PanelDialogHost />
        </PortalNote>
      );
    case "footers":
      return <Footers />;
    case "diagnostics":
      return (
        <div className="border border-border-default" style={{ width: 520, height: 300 }}>
          <DiagnosticsPanel paneId="surface-dev-preview" projectId="proj-acme" status="running" />
        </div>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <SeedWorktrees>
        <TooltipProvider delayDuration={300}>
          <Frame>
            <Shot />
          </Frame>
        </TooltipProvider>
      </SeedWorktrees>
    </WorktreeStoreProvider>
  </StrictMode>
);
