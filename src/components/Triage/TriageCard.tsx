import { Suspense, lazy, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { KeyRound, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SURFACE_HEADER_FOCUS_LIFT_CLASS, SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { AgentStateChip } from "@/components/Terminal/TerminalAgentIndicator";
import { getEffectiveStateLabel } from "@/components/Worktree/terminalStateConfig";
import type { BrandMarkSurface } from "@/lib/brandIcon";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { isMac } from "@/lib/platform";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { TriageItem } from "./triageModel";
import { KIND_LABEL } from "./TriageRow";
import { TriageTerminal, type TriageStreamState } from "./TriageTerminal";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

/** A grid pane's header control: a ghost icon button with a 14px glyph. */
const CONTROL_ICON = "[&_svg]:size-3.5";

export interface TriageCardHandlers {
  onOpen: (item: TriageItem) => void;
  onTrash: (item: TriageItem) => void;
  /** Something was typed and sent to the run from the pane. */
  onSent: (item: TriageItem) => void;
  /** Main refused what the composer sent; the draft is already gone. */
  onSendFailed: (item: TriageItem, error: unknown) => void;
}

/** What the list can ask of the pane for the agent it has selected. */
export interface TriageCardHandle {
  /** Handle a key aimed at the list's selected row; true when it was used. */
  handleKey: (event: KeyboardEvent<HTMLElement>) => boolean;
}

interface TriageCardProps extends TriageCardHandlers {
  item: TriageItem;
  domId: string;
  ref?: React.Ref<TriageCardHandle>;
}

/**
 * The composer is offered unless a secret is being asked for — by the card's
 * reading or by the live screen itself, which covers a run not read yet. A
 * composer keeps history, and a password must never land in it; a secret is
 * typed straight into the live terminal instead, which keeps nothing.
 */
export function canReplyTo(item: TriageItem, liveSecretPrompt = false): boolean {
  return !liveSecretPrompt && !(item.card?.secretPrompt === true && !item.stale);
}

/** Trash is offered where the run is done with or stuck: never on one at work. */
export function canTrashItem(item: TriageItem): boolean {
  return item.kind === "finished" || item.kind === "error" || item.kind === "idle";
}

export function triageCardDomId(runId: string): string {
  return `triage-card-${runId}`;
}

function HeaderControl({
  label,
  shortcut,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-keyshortcuts={shortcut}
          onClick={onClick}
          className={cn(
            CONTROL_ICON,
            destructive &&
              "hover:bg-status-error/15 hover:text-status-error focus-visible:bg-status-error/15 focus-visible:text-status-error focus-visible:outline-status-error"
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The selected agent, drawn the way its own pane draws it in the grid: the
 * panel frame, a compact header with the terminal's title and its controls,
 * then the terminal itself — live, on the WebGL renderer — with the real
 * composer flush beneath. Type, press Enter, and it goes to that agent, from
 * whichever project it is in.
 */
export function TriageCard({
  item,
  domId,
  ref,
  onOpen,
  onTrash,
  onSent,
  onSendFailed,
}: TriageCardProps) {
  const [stream, setStream] = useState<TriageStreamState>({
    watchId: null,
    ended: false,
    secretPrompt: false,
  });
  const composerRef = useRef<HybridInputBarHandle>(null);
  // The pane the keyboard is in lifts its title bar, as a focused grid pane does.
  const [focused, setFocused] = useState(false);
  const { row } = item;
  const run = row.run;
  const canReply = canReplyTo(item, stream.secretPrompt);
  const canTrash = canTrashItem(item);

  const handleKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    if ((event.key === "r" || event.key === "R") && canReply && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      composerRef.current?.focus();
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && canTrash) {
      event.preventDefault();
      onTrash(item);
      return true;
    }
    return false;
  };
  useImperativeHandle(ref, () => ({ handleKey }));

  const where = [item.workspace.name, row.worktreeLabel].filter(Boolean).join(" · ");
  const agentId = isBuiltInAgentId(run.agentId) ? run.agentId : undefined;
  // The grid's chip rules: nothing while idle, and a settled agent keeps its
  // glyph only to explain a session cost, which the panel does not have.
  const agentState = run.agentState;
  const showState =
    agentState !== undefined &&
    agentState !== "idle" &&
    agentState !== "completed" &&
    agentState !== "exited";
  const brandSurface: BrandMarkSurface = focused
    ? { surface: "surface-panel", extension: "panel-header-focus-bg", lift: "overlay-medium" }
    : { surface: "surface-panel", extension: "panel-header-bg" };

  // Through the open stream only, so main sends to the incarnation on screen
  // or to nothing.
  const send = (text: string, imagePaths?: string[]) => {
    const watchId = stream.watchId;
    if (watchId === null) return;
    window.electron.triage.terminalSubmit(watchId, text, imagePaths).then(
      () => onSent(item),
      (error: unknown) => onSendFailed(item, error)
    );
  };

  return (
    <section
      id={domId}
      aria-label={`${row.title}, ${KIND_LABEL[item.kind]}`}
      data-triage-detail=""
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
      }}
      className="group/panel flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-overlay bg-surface shadow-[var(--theme-shadow-ambient)] transition-colors duration-150 hover:border-tint/[0.08]"
    >
      <SurfaceHeader
        density="compact"
        brandSurface={brandSurface}
        className={cn(
          "relative overflow-hidden text-xs transition-colors select-none",
          focused ? SURFACE_HEADER_FOCUS_LIFT_CLASS : "bg-[var(--panel-header-bg,transparent)]"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <span
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-primary"
            data-brand-active={focused || undefined}
          >
            <TerminalIcon
              chrome={row.chrome}
              className="h-3.5 w-3.5"
              brandColor={row.presetColor ?? row.chrome.color}
            />
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <h3 className="min-w-[6ch] shrink truncate font-sans text-xs leading-6 font-medium text-text-primary">
                {row.title}
              </h3>
            </TooltipTrigger>
            <TooltipContent side="bottom">{row.title}</TooltipContent>
          </Tooltip>
          <span className="min-w-0 shrink-[2] truncate text-xs leading-6 text-text-secondary">
            {where}
          </span>
        </div>
        <div
          role="toolbar"
          aria-label="Terminal"
          className="ml-1.5 flex shrink-0 items-center gap-1"
        >
          {canTrash && (
            <HeaderControl
              label="Trash terminal"
              shortcut={isMac() ? "Meta+Backspace" : "Control+Backspace"}
              onClick={() => onTrash(item)}
              destructive
            >
              <Trash2 aria-hidden="true" />
            </HeaderControl>
          )}
          <HeaderControl label="Go to terminal" onClick={() => onOpen(item)}>
            <SquareArrowOutUpRight aria-hidden="true" />
          </HeaderControl>
        </div>
        {/* The agent's state chip, in the reserved box at the far right where every agent pane keeps it. */}
        {agentId !== undefined && (
          <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center">
            {showState && (
              <AgentStateChip
                agentState={agentState}
                ariaLabel={`Agent state: ${getEffectiveStateLabel(agentState)}`}
              />
            )}
          </span>
        )}
      </SurfaceHeader>

      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas"
        // Escape belongs to the agent here — it interrupts or backs out of a
        // menu — so it must not also close the dialog around it.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        <TriageTerminal
          key={`${item.runId}:${run.spawnedAt}`}
          runId={item.runId}
          spawnedAt={run.spawnedAt}
          onStreamChange={setStream}
        />
        {canReply ? (
          <div data-keybindings-isolated="" className="contents">
            <Suspense fallback={null}>
              <LazyHybridInputBar
                ref={composerRef}
                isolated
                terminalId={item.runId}
                cwd={run.cwd ?? ""}
                agentId={agentId}
                agentState={run.agentState}
                disabled={stream.watchId === null}
                onSend={({ text, imagePaths }) => send(text, imagePaths)}
                onSendKey={(key) => {
                  const watchId = stream.watchId;
                  if (watchId === null) return;
                  window.electron.triage.terminalSendKey(watchId, key).then(
                    () => onSent(item),
                    (error: unknown) => onSendFailed(item, error)
                  );
                }}
              />
            </Suspense>
          </div>
        ) : (
          <p className="flex shrink-0 items-center gap-1.5 px-3.5 py-3 text-xs text-text-secondary">
            <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
            It's asking for a secret: type it straight into the terminal above
          </p>
        )}
      </div>
    </section>
  );
}
