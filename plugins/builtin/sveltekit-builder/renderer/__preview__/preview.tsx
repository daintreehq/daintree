import "./installShims";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevPreviewToolDrawerChrome } from "@/components/DevPreview/DevPreviewToolDrawerChrome";
import { usePanelStore } from "@/store/panelStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { SiteBuilderDrawer, SiteBuilderToolbar } from "../SiteBuilderSurfaces.js";
import { createBuilderSession } from "../inspectorController.js";
import { __resetComposerMemoryForTests } from "../composerMemory.js";
import { fixtureFor, PANEL_ID, WORKTREE_ID, isFixtureName, type FixtureName } from "./fixtures.js";
import { getPreviewHost } from "./installShims";
import "@/index.css";

/**
 * Standalone visual-review harness for SvelteKit Tools.
 *
 * The builder's states are things a live dev server and a real agent decide —
 * a page that has not loaded, a component whose source main is still finding, a
 * request half-way into an agent's input, a project whose Svelte version cannot
 * be edited. Reaching them in the app means a cold Vite start and a real CLI per
 * state, which is minutes each and flaky on a loaded machine.
 *
 * So this mounts the REAL `SiteBuilderToolbar` and `SiteBuilderDrawer` against
 * the real theme tokens and the real `index.css`, driven by the real
 * `InspectorController` over a stand-in bridge that speaks the same protocol.
 * Nothing inside the strip or the drawer is a copy.
 *
 * What IS a stand-in: the browser chrome above the strip and the page beside the
 * drawer. Both are here only so the builder is judged in its real proportions
 * rather than floating on an empty page.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=element          one state; required
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "element";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "element";
const fixture = fixtureFor(fixtureName);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));

function ptyRow(id: string, extra: Partial<PtyPanelData>): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/Users/you/code/orchid-studio",
    cols: 120,
    rows: 40,
    worktreeId: WORKTREE_ID,
    ...extra,
  } as PtyPanelData;
}

const rows: Record<string, PtyPanelData> = {};
for (const terminal of fixture.terminals ?? []) {
  rows[terminal.id] = ptyRow(terminal.id, {
    title:
      terminal.detectedAgentId === "codex" ? "codex · docs rewrite" : "claude · pricing polish",
    lastObservedTitle:
      terminal.detectedAgentId === "codex"
        ? "Rewriting the docs nav"
        : "Polishing the pricing page",
    ...terminal,
  });
}
usePanelStore.setState({
  panelsById: rows,
  panelIds: Object.keys(rows),
} as Partial<ReturnType<typeof usePanelStore.getState>>);

// The composer offers a fresh session only for CLIs it believes are installed.
useCliAvailabilityStore.setState({
  isInitialized: true,
  availability: { claude: "ready", codex: "ready", gemini: "ready" },
} as never);

__resetComposerMemoryForTests();

/** A still of a SvelteKit marketing page, so the drawer is judged beside real weight. */
function MockSite() {
  return (
    <div className="flex h-full min-w-0 flex-1 justify-center overflow-hidden bg-white">
      <div className="w-full max-w-[720px] px-10 py-12 font-sans text-[#0f172a]">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">Pricing</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">Ship your site faster</h1>
        <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-[#475569]">
          Everything you need to design, build and deploy — with your own agent doing the typing.
        </p>
        <div className="mt-8 grid grid-cols-2 gap-4">
          {[
            { name: "Starter", price: "$0", note: "For side projects" },
            { name: "Pro", price: "$24", note: "For growing teams" },
          ].map((plan, index) => (
            <div
              key={plan.name}
              className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-sm"
            >
              <p className="text-sm font-semibold">{plan.name}</p>
              <p className="mt-2 text-3xl font-bold">
                {plan.price}
                <span className="text-sm font-normal text-[#64748b]">/mo</span>
              </p>
              <p className="mt-1 text-xs text-[#64748b]">{plan.note}</p>
              <button
                type="button"
                style={
                  index === 1
                    ? {
                        marginTop: 16,
                        width: "100%",
                        borderRadius: "var(--radius-md)",
                        background: "#4f46e5",
                        color: "#ffffff",
                        padding: "12px 24px",
                        fontSize: "var(--text-sm)",
                        fontWeight: 500,
                        outline: "2px solid #0ea5e9",
                        outlineOffset: 2,
                      }
                    : {
                        marginTop: 16,
                        width: "100%",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        padding: "12px 24px",
                        fontSize: "var(--text-sm)",
                        fontWeight: 500,
                      }
                }
              >
                {index === 1 ? "Start Pro" : "Start free"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The dev preview's own browser chrome, so the strip sits where it really sits. */
function MockBrowserToolbar() {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-overlay bg-surface px-2">
      {[ArrowLeft, ArrowRight, RotateCw].map((Icon, index) => (
        <span
          key={index}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-md)] text-text-secondary"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      ))}
      <div className="ml-1 flex h-6 min-w-0 flex-1 items-center rounded-[var(--radius-md)] border border-border-subtle bg-surface-inset px-2 text-xs text-text-secondary">
        localhost:5173/pricing
      </div>
    </div>
  );
}

// In the app the host owns this; here the harness is the host, so it builds the
// one session the surfaces read before either of them mounts.
const hostContext = {
  panelId: PANEL_ID,
  projectId: "p1",
  worktreeId: WORKTREE_ID,
  worktreePath: "/Users/you/code/orchid-studio",
  url: "http://localhost:5173/pricing",
  isWebviewReady: true,
};
const session = createBuilderSession({
  ...hostContext,
  visible: true,
  signal: new AbortController().signal,
});

function Harness() {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const props = { ...hostContext, session, onClose: () => {} };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fixture.act?.(getPreviewHost());
      } catch (error) {
        // A drive that could not reach its state must say so loudly. Silence
        // here is how a harness photographs the wrong screen and calls it a
        // review.
        if (cancelled) return;
        const message = formatErrorMessage(error, "the fixture drive threw");
        console.error(`[site-builder-preview] fixture "${fixtureName}" failed: ${message}`);
        setFailure(message);
        return;
      }
      if (cancelled) return;
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TooltipProvider>
      <div
        data-fixture={fixtureName}
        data-ready={ready ? "true" : "false"}
        data-failure={failure ?? undefined}
        className="flex h-screen w-screen flex-col overflow-hidden bg-surface-canvas text-text-primary"
      >
        <MockBrowserToolbar />
        <SiteBuilderToolbar {...props} />
        {/* The host's drawer chrome, as in the app: the width, the resize handle
            and the narrow-pane policy are its, not the plugin's. */}
        <div className="relative flex min-h-0 flex-1">
          <MockSite />
          <DevPreviewToolDrawerChrome>
            <SiteBuilderDrawer {...props} />
          </DevPreviewToolDrawerChrome>
        </div>
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("preview root missing");
createRoot(root).render(<Harness />);
