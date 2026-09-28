// Imported FIRST so the bridge shim exists before any module reaches for
// `window.electron` at evaluation time.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
installPreviewShims();

import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Bell, BellOff, Clock, Layers, Pencil, Pin, ShieldOff, X } from "lucide-react";
import { Box, Cloud, Container, Database, Globe, Laptop, Server, Terminal } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { EventRecord } from "@shared/types/ipc/events";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRESSED_TOGGLE } from "@/components/Diagnostics/toggleStyles";
import { LogsActions, TelemetryActions } from "@/components/Diagnostics/DiagnosticsActions";
import { LogFilters } from "@/components/Logs/LogFilters";
import { EventFilters } from "@/components/EventInspector/EventFilters";
import { EventDetail } from "@/components/EventInspector/EventDetail";
import { useLogsStore } from "@/store";
import { useEventStore } from "@/store/eventStore";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import "@/index.css";

/**
 * Visual-review harness for pressed toggle buttons and filter chips.
 *
 * Every toggle and chip family the consistency pass touches, side by side, each
 * on the surface its consumer sits on and in both states. The diagnostics
 * actions, log filters, event filters and event detail are the REAL components
 * against seeded stores. The rest live inside components too heavy to mount
 * here (audit log viewers, the recipes tab, the lightbox, the artifact overlay,
 * the background row, the notification center, the plugin manager), so each
 * specimen spells the control with exactly the props its site passes. A
 * migration edits the specimen alongside the site.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib|...   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

useLogsStore.setState({ autoScroll: true });
useTelemetryPreviewStore.setState({ active: true, stateRead: "known" });
useEventStore.setState({ filters: { worktreeId: "wt-feature-login" } });

const NOW = Date.now() - 60_000;

const EVENTS: EventRecord[] = [
  ["agent", "agent:state-changed"],
  ["agent", "agent:completed"],
  ["system", "sys:worktree:update"],
  ["server", "server:started"],
  ["file", "file:changed"],
  ["file", "file:changed"],
  ["ui", "ui:notify"],
].map(([category, type], i) => ({
  id: `ev-${i}`,
  timestamp: NOW - i * 4_000,
  type,
  category: category as EventRecord["category"],
  source: "main",
  payload: {
    worktreeId: i % 2 === 0 ? "wt-feature-login" : "wt-main",
    agentId: "claude-3",
    terminalId: "term-7f2c",
    traceId: "trace-91ab",
  },
}));

function Specimen({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={id} className="w-[560px] p-3 bg-surface-canvas">
      <div className="mb-2 text-2xs text-text-secondary">{title}</div>
      {children}
    </section>
  );
}

function Frame({
  caption,
  surface = "bg-surface-panel",
  children,
}: {
  caption: string;
  surface?: string;
  children: ReactNode;
}) {
  return (
    <div data-frame={caption} className="mb-2">
      <div className="mb-1 text-3xs text-text-secondary">{caption}</div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-divider p-3",
          surface
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ── Toggle buttons, spelled as their sites spell them ─────────────────────── */

function AuditToggles() {
  const [groupByTurn, setGroupByTurn] = useState(true);
  const [ignoreLastHour, setIgnoreLastHour] = useState(false);
  return (
    <>
      <Frame caption="MCP audit log — quick views">
        <Button variant="outline" size="sm">
          <ShieldOff aria-hidden="true" />
          Show unauthorized (3)
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={groupByTurn}
          onClick={() => setGroupByTurn((v) => !v)}
          className={cn(groupByTurn && "bg-overlay-selected text-text-primary")}
        >
          <Layers aria-hidden="true" />
          Group by turn
        </Button>
      </Frame>
      <Frame caption="Forge audit log — off, then on">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={ignoreLastHour}
          onClick={() => setIgnoreLastHour((v) => !v)}
          className={cn(ignoreLastHour && "bg-overlay-selected text-text-primary")}
        >
          <Clock aria-hidden="true" />
          Ignore last hour
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={true}
          className="bg-overlay-selected text-text-primary"
        >
          <Clock aria-hidden="true" />
          Ignore last hour
        </Button>
      </Frame>
    </>
  );
}

function LightboxToggle({ pressed }: { pressed: boolean }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      className="shrink-0 aria-pressed:bg-overlay-active aria-pressed:text-text-primary aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
    >
      Actual size
    </Button>
  );
}

function RecipePin({ name, isDefault }: { name: string; isDefault: boolean }) {
  return (
    <div className="flex w-full items-center justify-between rounded-[var(--radius-md)] border border-border-default px-3 py-2">
      <span className="text-xs text-text-primary">{name}</span>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={isDefault}
          aria-label={
            isDefault
              ? `Unset ${name} as default worktree recipe`
              : `Set ${name} as default worktree recipe`
          }
          className={cn(isDefault && "bg-overlay-selected text-text-primary")}
        >
          <Pin className={isDefault ? "fill-current" : undefined} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${name}`}>
          <Pencil />
        </Button>
      </div>
    </div>
  );
}

const ENV_ICONS = [Server, Laptop, Cloud, Container, Database, Globe, Box, Terminal];

function EnvironmentIcons() {
  return (
    <div role="group" aria-label="Environment icon" className="grid grid-cols-5 gap-1">
      {ENV_ICONS.map((IconComp, i) => {
        const isSelected = i === 2;
        return (
          <Button
            key={i}
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={isSelected}
            aria-label={`Icon ${i}`}
            className={cn(isSelected && "bg-overlay-active text-text-primary")}
          >
            <IconComp />
          </Button>
        );
      })}
    </div>
  );
}

function ArtifactCodeOnly({ codeOnly }: { codeOnly: boolean }) {
  return (
    <div className="flex">
      <Button variant="subtle" size="sm" className="rounded-r-none">
        Copy all
      </Button>
      <Button
        variant="subtle"
        size="sm"
        aria-pressed={codeOnly}
        className={cn("rounded-l-none", codeOnly && "bg-overlay-strong text-text-primary")}
      >
        Code only
      </Button>
    </div>
  );
}

function WatchRow({ isWatched }: { isWatched: boolean }) {
  return (
    <div className="flex w-full items-start justify-between gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 hover:bg-overlay-hover">
      <div className="min-w-0">
        <div className="text-xs text-text-primary">claude — fix login redirect</div>
        <div className="text-2xs text-text-secondary">working · 4m</div>
      </div>
      <div className="flex gap-0.5 shrink-0 mt-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={isWatched ? "Stop watching" : "Watch for completion"}
          aria-pressed={isWatched}
          data-testid="bg-watch-button"
          className={cn(isWatched && "text-status-info")}
        >
          {isWatched ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close">
          <X />
        </Button>
      </div>
    </div>
  );
}

function ReEntryPin({ isPinned }: { isPinned: boolean }) {
  return (
    <div className="flex w-[260px] items-center justify-between rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated px-3 py-2">
      <span className="text-xs font-medium text-text-primary">While you were away</span>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Pin summary"
          aria-pressed={isPinned}
          className={cn("[&_svg]:size-3.5", isPinned && "text-text-primary")}
        >
          <Pin aria-hidden="true" className={cn(isPinned && "fill-current")} />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss summary">
          <X />
        </Button>
      </div>
    </div>
  );
}

/* ── Filter chips, spelled as their sites spell them ───────────────────────── */

function WorktreeChip({
  label,
  isActive,
  count,
}: {
  label: string;
  isActive: boolean;
  count?: number;
}) {
  const isUnavailable = count === 0 && !isActive;
  return (
    <button
      type="button"
      aria-pressed={isActive}
      data-filter-chip="true"
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-2xs transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary",
        isActive
          ? "border-text-secondary bg-filter-selected-bg-strong font-medium text-text-primary"
          : isUnavailable
            ? "border-border-default bg-transparent text-text-secondary hover:text-text-primary"
            : "border-text-secondary bg-overlay-soft text-text-secondary hover:bg-overlay-medium hover:text-text-primary"
      )}
    >
      {count === undefined ? label : `${label} (${count})`}
    </button>
  );
}

function InboxChip({ label, selected }: { label: string; selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-filter-chip="true"
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-2xs rounded-full transition-colors",
        selected
          ? "bg-filter-selected-bg-strong text-text-primary font-medium"
          : "text-text-secondary hover:text-text-primary hover:bg-tint/[0.04]"
      )}
    >
      {label}
    </button>
  );
}

function PluginChip({ label, active }: { label: string; active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "px-1.5 py-0.5 rounded-sm text-3xs font-medium border transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
        active
          ? "bg-overlay-medium border-text-secondary text-text-primary forced-colors:border-[Highlight]"
          : "bg-overlay-subtle border-border-default/50 text-text-secondary hover:text-text-primary hover:border-border-default"
      )}
    >
      {label}
    </button>
  );
}

function Gallery() {
  const [logFilters, setLogFilters] = useState({
    levels: ["info", "error"] as ("debug" | "info" | "warn" | "error")[],
    sources: ["WorkspaceService"],
  });
  const [eventFilters, setEventFilters] = useState<{
    categories?: EventRecord["category"][];
    traceId?: string;
  }>({ categories: ["agent"], traceId: "trace-91ab" });

  return (
    <div data-preview-shell className="flex flex-wrap items-start gap-4 p-4">
      <Specimen id="audit" title="Settings audit logs — pressed toggles (outline sm)">
        <AuditToggles />
      </Specimen>

      <Specimen id="small-toggles" title="Lightbox, artifact overlay, recipes, re-entry pin">
        <Frame caption="Figure lightbox caption — off, on" surface="bg-surface-panel-elevated">
          <LightboxToggle pressed={false} />
          <LightboxToggle pressed={true} />
        </Frame>
        <Frame caption="Artifact overlay — Code only off, on">
          <ArtifactCodeOnly codeOnly={false} />
          <ArtifactCodeOnly codeOnly={true} />
        </Frame>
        <Frame caption="Recipes tab — default pin off, on">
          <RecipePin name="Install and dev server" isDefault={false} />
          <RecipePin name="Claude + tests" isDefault={true} />
        </Frame>
        <Frame caption="Re-entry summary — pin off, on" surface="bg-surface-canvas">
          <ReEntryPin isPinned={false} />
          <ReEntryPin isPinned={true} />
        </Frame>
      </Specimen>

      <Specimen id="icon-toggles" title="Environment icon picker, background watch bell">
        <Frame caption="Resource environment icon picker (popover)" surface="surface-overlay">
          <EnvironmentIcons />
        </Frame>
        <Frame caption="Background panes — watch off, on" surface="bg-surface-panel">
          <WatchRow isWatched={false} />
          <WatchRow isWatched={true} />
        </Frame>
      </Specimen>

      <Specimen id="diagnostics" title="Diagnostics dock — logs tab (real components)">
        <Frame caption="Logs actions + telemetry actions" surface="bg-surface-panel">
          <LogsActions />
          <TelemetryActions />
        </Frame>
        <div className="rounded-[var(--radius-md)] border border-divider bg-surface-panel">
          <LogFilters
            filters={logFilters}
            onFiltersChange={(next) =>
              setLogFilters((prev) => ({ ...prev, ...(next as typeof prev) }))
            }
            onClear={() => setLogFilters({ levels: [], sources: [] })}
            availableSources={["WorkspaceService", "PtyHost", "McpServer"]}
            levelCounts={{ debug: 0, info: 214, warn: 12, error: 3 }}
            sourceCounts={{ WorkspaceService: 90, PtyHost: 120, McpServer: 19 }}
          />
        </div>
      </Specimen>

      <Specimen id="events" title="Event inspector (real components)">
        <div className="rounded-[var(--radius-md)] border border-divider bg-surface-panel">
          <EventFilters
            events={EVENTS}
            filters={eventFilters}
            onFiltersChange={(next) => setEventFilters(next as typeof eventFilters)}
          />
        </div>
        <div className="mt-2 h-[360px] overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel">
          <EventDetail event={EVENTS[0]!} />
        </div>
      </Specimen>

      <Specimen id="chips" title="Filter chips — worktree (canonical), inbox, plugins">
        <Frame
          caption="Worktree filter popover — selected, available, unavailable"
          surface="surface-overlay"
        >
          <WorktreeChip label="Dirty" isActive={true} count={3} />
          <WorktreeChip label="Clean" isActive={false} count={5} />
          <WorktreeChip label="Stale" isActive={false} count={0} />
          <WorktreeChip label="Ahead" isActive={false} count={2} />
        </Frame>
        <Frame caption="Notification center — inbox filters" surface="surface-overlay">
          <InboxChip label="All" selected={false} />
          <InboxChip label="Unread" selected={true} />
          <InboxChip label="Archived" selected={false} />
        </Frame>
        <Frame caption="Plugin manager — filter chips" surface="bg-surface-panel">
          <PluginChip label="Agents" active={true} />
          <PluginChip label="Forge" active={false} />
          <PluginChip label="Editors" active={false} />
          <PluginChip label="Disabled" active={false} />
        </Frame>
        <Frame
          caption="Diagnostics shared toggle recipe (PRESSED_TOGGLE)"
          surface="bg-surface-panel"
        >
          <Button variant="subtle" size="xs" aria-pressed={true} className={PRESSED_TOGGLE}>
            Pressed
          </Button>
          <Button variant="subtle" size="xs" aria-pressed={false}>
            Not pressed
          </Button>
        </Frame>
      </Specimen>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Gallery />
    </TooltipProvider>
  </StrictMode>
);
