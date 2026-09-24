import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Bot, GitBranch } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import type { AgentState } from "@shared/types";
import { ActivityLight } from "../ActivityLight";
import { agentStateDotColor, getAttentionAgentState } from "../terminalStateConfig";
import { WorktreeActivityChip } from "../WorktreeCard/WorktreeActivityChip";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree activity light and the
 * agent-state pips on the toolbar and dock agent buttons.
 *
 * The light's meaning is its age: solid for five minutes after the last
 * activity, a colour fade over the next five, then a hollow ring. A real session
 * shows whichever point on that curve the worktree happens to be at, so the
 * states that decide the design (the middle of the fade, the moment it turns
 * hollow) are not ones you can ask for. This mounts the REAL `ActivityLight` and
 * `WorktreeActivityChip` at fixed ages against the real theme tokens and
 * `index.css`. The card rows, the toolbar buttons and the labels are harness
 * decoration; the pips use the real `toolbar-pip toolbar-badge` classes,
 * `getAttentionAgentState` and `agentStateDotColor`.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>   (default daintree)
 */

installPreviewShims();

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const AGES = [
  { key: "fresh", label: "20s", age: 20 * SECOND, branch: "feature/stream-upload-retry" },
  { key: "hold", label: "4m", age: 4 * MINUTE, branch: "fix/queue-drain-ordering" },
  { key: "fade-early", label: "6m", age: 6 * MINUTE, branch: "feature/columnar-export" },
  { key: "fade-mid", label: "7m 30s", age: 7.5 * MINUTE, branch: "chore/bump-electron-42" },
  { key: "fade-late", label: "9m 30s", age: 9.5 * MINUTE, branch: "spike/wasm-tokenizer" },
  { key: "idle", label: "11m", age: 11 * MINUTE, branch: "docs/plugin-author-guide" },
  { key: "idle-old", label: "3h", age: 3 * HOUR, branch: "refactor/archive-legacy-ingest" },
] as const;

const NOW = Date.now();

function Section({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="flex flex-col gap-2 p-3">
      <h2 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

/** The collapsed worktree card's details row: branch left, activity chip right. */
function CardRows() {
  return (
    <div className="flex w-[340px] flex-col gap-1.5 rounded-[var(--radius-md)] bg-surface-sidebar p-2">
      {AGES.map(({ key, age, branch }) => (
        <div
          key={key}
          data-age={key}
          className="sidebar-worktree-card relative isolate"
          data-variant="sidebar"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
              <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate font-mono">{branch}</span>
            </div>
            <WorktreeActivityChip
              lastActivityTimestamp={NOW - age}
              lastCommitTimestampMs={NOW - 3 * HOUR}
              author={{ name: "Avery Lindqvist", email: "avery@helios.dev" }}
              commitMessage="Honour Retry-After on 429 responses"
              commitSha="9f3c2a1b7e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every age at the real 6px chip size and at 4× so ring and fill can be judged. */
function DotStrip() {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-md)] bg-surface-panel p-3">
      {[
        { label: "chip size", zoom: 1 },
        { label: "4× chip size", zoom: 4 },
      ].map((row) => (
        <div key={row.label} className="flex items-end gap-5">
          <span className="w-24 shrink-0 text-2xs text-text-secondary">{row.label}</span>
          {AGES.map(({ key, label, age }) => (
            <div key={key} className="flex w-14 flex-col items-center gap-1.5">
              <div style={{ zoom: row.zoom }}>
                <ActivityLight lastActivityTimestamp={NOW - age} />
              </div>
              <span className="text-2xs tabular-nums text-text-secondary">{label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** One agent's sessions, as the toolbar button aggregates them. */
const PIP_CASES: { label: string; sessions: AgentState[] }[] = [
  { label: "waiting", sessions: ["waiting"] },
  { label: "directing", sessions: ["directing"] },
  { label: "working + waiting", sessions: ["working", "waiting"] },
  { label: "working + directing", sessions: ["working", "directing"] },
  { label: "working", sessions: ["working"] },
  { label: "idle", sessions: ["idle"] },
];

/** Toolbar-sized icon buttons carrying the real pip classes. */
function Pips() {
  return (
    <div className="flex items-end gap-4 rounded-[var(--radius-md)] bg-surface-sidebar px-3 py-2">
      {PIP_CASES.map(({ label, sessions }) => {
        const state = getAttentionAgentState(sessions);
        const color = state ? agentStateDotColor(state) : null;
        return (
          <div key={label} className="flex w-24 flex-col items-center gap-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-text-secondary">
              <div className="relative">
                <Bot className="h-4 w-4" aria-hidden="true" />
                <span
                  className={cn("toolbar-pip toolbar-badge", color)}
                  data-visible={!!color}
                  aria-hidden="true"
                />
              </div>
            </div>
            <span className="text-center text-2xs text-text-secondary">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Preview() {
  return (
    <div data-preview-shell className="inline-flex flex-col gap-1 p-2 text-text-primary">
      <Section shot="rows" title="Worktree card — activity chip">
        <CardRows />
      </Section>
      <Section shot="dots" title="Activity light — decay curve">
        <DotStrip />
      </Section>
      <Section shot="pips" title="Toolbar agent pips — one agent's sessions">
        <Pips />
      </Section>
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
