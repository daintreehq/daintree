import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PluginDiagnosticsLogLine } from "@shared/types/ipc/pluginDiagnostics";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { PluginLogsSection, type PluginLogsState } from "../PluginLogsSection";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the plugin log buffer section, the body
 * of the plugin manager's Logs tab and the Logs block of a project plugin.
 *
 * The section is presentational — the hook hands it lines, a loading flag and
 * an error — so every state renders side by side from fixed props, at the
 * width the detail pane gives it.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?width=560                specimen width in CSS px
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
const width = Number(params.get("width") ?? "560");
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

// A fixed clock, so captures compare byte for byte across rounds.
const BASE = new Date(2026, 9, 21, 14, 2, 7, 0).getTime();
const at = (s: number) => BASE + s * 1000;

const POPULATED: PluginDiagnosticsLogLine[] = [
  { ts: at(0), level: "info", message: "activate: registering 3 commands and 1 panel" },
  { ts: at(0.4), level: "info", message: "panel acme.linear.issues: view bound" },
  { ts: at(2), level: "warn", message: "settings.apiToken is empty — falling back to anonymous" },
  { ts: at(3.2), level: "info", message: "sync: fetched 42 issues in 318ms" },
  {
    ts: at(9),
    level: "error",
    message:
      "sync failed: GET https://api.linear.app/graphql/v1/issues?first=50&after=cursor_0f3a returned 401 Unauthorized",
  },
  {
    ts: at(9.1),
    level: "error",
    message:
      "TypeError: Cannot read properties of undefined (reading 'nodes')\n    at mapIssues (dist/sync.js:88:21)\n    at async runSync (dist/sync.js:41:5)",
  },
  { ts: at(15), level: "info", message: "retrying in 30s" },
  { ts: at(45), level: "warn", message: "rate limit: 4 requests left this window" },
  { ts: at(46), level: "info", message: "sync: fetched 42 issues in 291ms" },
];

const LONG: PluginDiagnosticsLogLine[] = Array.from({ length: 60 }, (_, i) => ({
  ts: at(i * 7),
  level: i % 11 === 5 ? "error" : i % 7 === 3 ? "warn" : "info",
  message:
    i % 11 === 5
      ? `poll ${i}: request timed out after 10000ms`
      : i % 7 === 3
        ? `poll ${i}: slow response (2.4s)`
        : `poll ${i}: ok, ${(i * 13) % 40} changes`,
}));

const noop = () => undefined;
const state = (over: Partial<PluginLogsState>): PluginLogsState => ({
  lines: POPULATED,
  loading: false,
  error: null,
  readAt: at(50),
  hasLogged: true,
  refresh: noop,
  ...over,
});

function Specimen({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <p data-harness-decoration className="font-mono text-2xs text-text-secondary">
        {label}
      </p>
      {/* The detail pane's body: panel surface, its padding, its width. */}
      <div data-shot={id} className="bg-surface-panel p-6" style={{ width }}>
        {children}
      </div>
    </section>
  );
}

function ProjectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Logs</h4>
      {children}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="flex flex-col gap-8 p-8">
        <Specimen id="populated" label="populated — mixed levels, a wrapped URL, a stack">
          <PluginLogsSection {...state({})} />
        </Specimen>
        <Specimen id="long" label="long — 60 lines, the box scrolls">
          <PluginLogsSection {...state({ lines: LONG })} />
        </Specimen>
        <Specimen id="refreshing" label="refreshing — lines on screen, a read in flight">
          <PluginLogsSection {...state({ loading: true })} />
        </Specimen>
        <Specimen id="loading" label="loading — first read, nothing known yet">
          <PluginLogsSection {...state({ lines: null, loading: true, readAt: null })} />
        </Specimen>
        <Specimen id="empty" label="empty — ran, buffer cleared by a reload">
          <PluginLogsSection {...state({ lines: [] })} />
        </Specimen>
        <Specimen id="not-running" label="not running — no buffer">
          <PluginLogsSection {...state({ lines: null })} />
        </Specimen>
        <Specimen id="error" label="error — the read failed">
          <PluginLogsSection
            {...state({
              lines: null,
              error: "Couldn't read this plugin's log buffer: plugin host is restarting",
            })}
          />
        </Specimen>
        <Specimen id="error-stale" label="error — a refresh failed, the last good read stays">
          <PluginLogsSection
            {...state({
              error: "Couldn't read this plugin's log buffer: plugin host is restarting",
            })}
          />
        </Specimen>
        <Specimen id="project" label="project plugin pane — under its Logs label">
          <ProjectFrame>
            <PluginLogsSection {...state({})} />
          </ProjectFrame>
        </Specimen>
      </div>
    </TooltipProvider>
  </StrictMode>
);
