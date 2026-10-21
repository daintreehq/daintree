import { useMemo, type ComponentType } from "react";
import { cn } from "../../lib/utils";
import { classifyBranch, type BranchTypeId } from "@shared/config/branchPrefixes";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useFittedBranchText } from "./useFittedBranchName";
import { ClaudeIcon, CodexIcon, CopilotIcon, CursorIcon } from "@/components/icons/brands";
import {
  Accessibility,
  Blocks,
  BookOpen,
  Bug,
  CircuitBoard,
  Construction,
  Database,
  Flame,
  FlaskConical,
  GitBranch,
  GitPullRequestArrow,
  Hammer,
  HardDriveDownload,
  Infinity as InfinityIcon,
  Languages,
  LifeBuoy,
  Microscope,
  Palette,
  PencilRuler,
  Plug,
  Rocket,
  ShieldAlert,
  Shuffle,
  Sparkle,
  Undo2,
  Wrench,
  Zap,
} from "lucide-react";

/** A glyph drawn beside a branch: a Lucide icon or a monochrome brand mark. */
export type BranchGlyph = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

const BRANCH_TYPE_ICONS: Record<BranchTypeId, BranchGlyph> = {
  feature: Sparkle,
  bugfix: Bug,
  hotfix: Flame,
  security: ShieldAlert,
  design: PencilRuler,
  experiment: Microscope,
  refactor: Shuffle,
  chore: Wrench,
  docs: BookOpen,
  test: FlaskConical,
  release: Rocket,
  backport: GitPullRequestArrow,
  support: LifeBuoy,
  revert: Undo2,
  ci: InfinityIcon,
  build: Hammer,
  infra: CircuitBoard,
  deps: Blocks,
  migration: Database,
  perf: Zap,
  style: Palette,
  i18n: Languages,
  a11y: Accessibility,
  wip: Construction,
  backup: HardDriveDownload,
};

// Agents the roster already draws; any other agent namespace gets the app's agent glyph.
const AGENT_NAMESPACE_ICONS = new Map<string, BranchGlyph>([
  ["claude", ClaudeIcon],
  ["codex", CodexIcon],
  ["copilot", CopilotIcon],
  ["cursor", CursorIcon],
]);

export interface BranchTypeParts {
  /** The type the prefix names ("Feature", "Bugfix"), or null for a bare name. */
  displayName: string | null;
  Icon: BranchGlyph | null;
  /** The prefix exactly as the branch spells it, without its slash. */
  prefix: string;
  /** Everything after the prefix, uncut. */
  rest: string;
}

function formatUnknownPrefix(prefix: string): string {
  return prefix.length <= 4
    ? prefix.toUpperCase()
    : prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
}

/**
 * A branch as its type and the rest of its name: `feature/login` is a Feature
 * glyph and `login`. The sidebar draws every branch this way, so a surface
 * that shows the same branch uses this rather than its own map.
 *
 * A work type outranks who made the branch: `codex/fix/login` draws the Bugfix
 * glyph beside `fix/login`, and only `codex/login` draws Codex's mark.
 */
export function splitBranchType(label: string): BranchTypeParts {
  const { type, namespace, prefix, rest } = classifyBranch(label);
  if (type) {
    return { displayName: type.displayName, Icon: BRANCH_TYPE_ICONS[type.id], prefix, rest };
  }
  if (namespace?.kind === "agent") {
    return {
      displayName: namespace.displayName,
      Icon: AGENT_NAMESPACE_ICONS.get(namespace.id) ?? Plug,
      prefix,
      rest,
    };
  }
  if (!prefix) return { displayName: null, Icon: null, prefix: "", rest: label };
  return { displayName: formatUnknownPrefix(prefix), Icon: GitBranch, prefix, rest };
}

interface BranchLabelProps {
  label: string;
  isActive: boolean;
  isMuted?: boolean;
  className?: string;
}

/**
 * One size and weight wherever a branch is drawn, headline or meta line, so a
 * branch reads the same on every card. The prefix the glyph stands for and any
 * cut are given back by the tooltip, which only opens when something is hidden,
 * and by the sr-only full name, which is what assistive technology reads.
 */
export function BranchLabel({ label, isActive, isMuted, className }: BranchLabelProps) {
  const { Icon, prefix, rest } = useMemo(() => splitBranchType(label), [label]);
  const { shown, isCut, boxRef, sizerRef } = useFittedBranchText(rest);
  const isHiding = prefix !== "" || isCut;

  return (
    <TruncatedTooltip
      content={label}
      side="bottom"
      contentClassName="[overflow-wrap:anywhere]"
      isTruncated={isHiding}
      focusable={false}
    >
      <span
        data-branch-label=""
        className={cn("flex items-center gap-1.5 min-w-0 cursor-default", className)}
      >
        {isHiding && <span className="sr-only">{label}</span>}
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0 text-text-secondary" aria-hidden="true" />}
        {/* The cut name over the whole one: the box takes the whole name's
            width, so it only narrows when the card does. */}
        <span
          ref={boxRef}
          aria-hidden={isHiding || undefined}
          className={cn(
            "relative min-w-0 overflow-hidden whitespace-pre font-mono text-2xs transition-colors duration-150 ease-out",
            isActive
              ? "text-text-primary font-medium"
              : isMuted
                ? // Muted, not unreadable: `text-text-muted` has no dark contrast
                  // floor, so the de-emphasis comes off the weight instead, as
                  // the main card's project name does.
                  "text-text-secondary font-normal"
                : "text-text-secondary font-medium"
          )}
        >
          {/* Drawn from an attribute, so it sizes the box without being text. */}
          <span
            ref={sizerRef}
            data-text={rest}
            className="invisible before:content-[attr(data-text)]"
            aria-hidden="true"
          />
          <span className="absolute inset-y-0 left-0">{shown}</span>
        </span>
      </span>
    </TruncatedTooltip>
  );
}
