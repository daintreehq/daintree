import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { FolderGit2 } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { PaletteCurrentLabel } from "@/components/ui/PaletteCurrentLabel";
import {
  SESSION_COLORS,
  SESSION_ICONS,
  SESSION_LABELS,
} from "@/components/Worktree/terminalStateConfig";
import { useRunSessionPresentation } from "@/hooks/useRunSessionPresentation";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import {
  HighlightedText,
  findMatchIndices,
  wordMatchIndices,
} from "@/components/ui/HighlightedText";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TailKeepingText } from "@/components/ui/TailKeepingText";
import { PathTail } from "@/components/ui/PathTail";
import { pathTail, remapPathRanges, shortenPath } from "@/lib/pathTail";

export { pathTail };

export interface QuickSwitcherItemProps {
  item: QuickSwitcherItemData;
  isSelected: boolean;
  onSelect: (item: QuickSwitcherItemData) => void;
  onHover?: () => void;
  ariaDescribedBy?: string;
  /** Fuse match ranges for this row, when it was ranked for a query. */
  matches?: readonly FuseResultMatch[];
  /**
   * The query, for rows the built-in index never ranked: a plugin provider
   * answers with its own rows, so their emphasis is the query's words found
   * literally in the label rather than a range Fuse computed.
   */
  query?: string;
  /**
   * Say which provider a plugin row came from on the row itself. Off where a
   * band header or the scope chip already names it, so the provider isn't said
   * twice on every row; the accessible name keeps it either way.
   */
  showProvider?: boolean;
}

/**
 * The runtime a terminal row is running, when that says something its title
 * doesn't. A plain shell titled "Terminal" labelled "terminal" said the same
 * word twice; an agent pane the user renamed still benefits from "Claude".
 */
function runtimeLabel(item: QuickSwitcherItemData): string | null {
  if (item.type !== "terminal") return null;
  const label = item.chrome?.label?.trim();
  if (!label) return null;
  return label.toLowerCase() === item.title.trim().toLowerCase() ? null : label;
}

/** Match ranges on the full subtitle that fall inside its leading `context`. */
function contextIndices(
  matches: readonly FuseResultMatch[] | undefined,
  context: string
): [number, number][] | undefined {
  const ranges = findMatchIndices(matches, "subtitle");
  if (!ranges) return undefined;
  const kept: [number, number][] = [];
  for (const [s, e] of ranges) {
    if (s >= context.length) continue;
    kept.push([s, Math.min(e, context.length - 1)]);
  }
  return kept.length > 0 ? kept : undefined;
}

function AgentStateMark({ item }: { item: QuickSwitcherItemData }) {
  const terminalId = item.id.replace(/^terminal:/, "");
  const display = useRunSessionPresentation(
    terminalId,
    item.chrome ? getTerminalAgentDisplayState(item.chrome, item.agentState) : undefined
  );
  if (!display) return null;
  const Icon = SESSION_ICONS[display];
  return (
    <>
      <span className="sr-only">, agent {SESSION_LABELS[display]}</span>
      <Icon
        className={cn(
          "w-3 h-3 shrink-0",
          SESSION_COLORS[display],
          display === "working" && "animate-spin-slow motion-reduce:animate-none"
        )}
        aria-hidden="true"
      />
    </>
  );
}

/**
 * One row of the quick switcher, in the family's anatomy: a type glyph, the
 * name, the context that tells same-named rows apart beside it, a quieter detail
 * line only when there is something to add, and a trailing slot for state and
 * "Current".
 */
export function QuickSwitcherItem({
  item,
  isSelected,
  onSelect,
  onHover,
  ariaDescribedBy,
  matches,
  query,
  showProvider = true,
}: QuickSwitcherItemProps) {
  const isTerminal = item.type === "terminal";
  const isPlugin = item.type === "plugin";
  const providerTitle = isPlugin ? (item.pluginHit?.providerTitle ?? null) : null;
  const context = isTerminal ? item.context : undefined;

  // The query's words where they appear literally, and Fuse's fuzzy ranges only
  // where they don't: a fuzzy range can start a word early ("the token" for
  // "auth token"), which marks text the user never typed.
  const titleIndices =
    wordMatchIndices(item.title, query) ??
    (isPlugin ? undefined : findMatchIndices(matches, "title"));

  // The detail line: where a worktree is on disk, what a plugin row describes,
  // or for a panel the runtime and whether it is parked. A panel with nothing
  // to add gets no second line at all.
  const runtime = runtimeLabel(item);
  const terminalDetail = isTerminal
    ? [runtime, item.isBackground ? "Backgrounded" : null].filter(Boolean).join(" · ") || null
    : null;
  const shortened = item.type === "worktree" && item.subtitle ? shortenPath(item.subtitle) : null;
  const hasDetail = !!terminalDetail || (isPlugin && !!item.subtitle) || shortened !== null;

  return (
    <button
      id={`qs-option-${item.id}`}
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={onHover}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-3 px-3 rounded-[var(--radius-md)] text-left",
        hasDetail ? "py-2" : "py-1.5",
        "text-text-secondary"
      )}
      onClick={() => onSelect(item)}
      aria-selected={isSelected}
      aria-current={item.isCurrent ? "true" : undefined}
      aria-describedby={ariaDescribedBy}
      role="option"
    >
      <span className="shrink-0 text-text-secondary" aria-hidden="true">
        {isTerminal ? (
          <TerminalIcon kind={item.terminalKind} chrome={item.chrome} />
        ) : isPlugin ? (
          <PanelKindIcon iconId={item.pluginHit?.row.iconId ?? ""} size={16} />
        ) : (
          <FolderGit2 className="w-4 h-4" />
        )}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          {item.type === "worktree" ? (
            // A worktree's title is its branch, and branches differ at the end.
            <TailKeepingText
              text={item.title}
              indices={titleIndices}
              className="text-sm font-medium text-text-primary"
            />
          ) : (
            <span
              className={cn(
                "text-sm font-medium text-text-primary truncate",
                // A long title must leave the context room: the context is
                // what tells three "Claude" rows apart.
                context ? "shrink-0 max-w-[60%]" : "min-w-0"
              )}
            >
              <HighlightedText text={item.title} indices={titleIndices} />
            </span>
          )}
          {context && (
            <span className="flex min-w-0 text-sm text-text-secondary">
              <span className="sr-only">, in </span>
              <TailKeepingText
                text={context}
                indices={wordMatchIndices(context, query) ?? contextIndices(matches, context)}
              />
            </span>
          )}
          {item.isCurrent && <span className="sr-only">, current</span>}
          {providerTitle &&
            (showProvider ? (
              <span className="shrink-0 text-xs text-text-secondary">
                <span className="sr-only">, from </span>
                {providerTitle}
              </span>
            ) : (
              <span className="sr-only">, from {providerTitle}</span>
            ))}
        </div>
        {terminalDetail && (
          <div className="mt-0.5 text-xs text-text-secondary truncate">{terminalDetail}</div>
        )}
        {isPlugin && item.subtitle && (
          <div className="mt-0.5 text-xs text-text-secondary truncate">
            <HighlightedText
              text={item.subtitle}
              indices={wordMatchIndices(item.subtitle, query)}
            />
          </div>
        )}
        {shortened && item.subtitle && (
          <Tooltip autoDismiss={false}>
            <TooltipTrigger asChild>
              <div className="mt-0.5 flex min-w-0 text-xs text-text-secondary">
                <PathTail
                  className="block min-w-0"
                  indices={remapPathRanges(findMatchIndices(matches, "subtitle"), shortened.start)}
                >
                  {shortened.text}
                </PathTail>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">{item.subtitle}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {(isTerminal || item.isCurrent) && (
        <span className="flex shrink-0 items-center gap-2">
          {isTerminal && <AgentStateMark item={item} />}
          {item.isCurrent && <PaletteCurrentLabel />}
        </span>
      )}
    </button>
  );
}
