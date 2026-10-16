import { useMemo, type ComponentType } from "react";
import { cn } from "../../lib/utils";
import { truncateBranchName } from "../../utils/textParsing";
import { classifyBranch, type BranchTypeId } from "@shared/config/branchPrefixes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ClaudeIcon, CodexIcon, CopilotIcon, CursorIcon } from "@/components/icons/brands";
import {
  Accessibility,
  Archive,
  BookOpen,
  Bot,
  Bug,
  Construction,
  Database,
  Flame,
  FlaskConical,
  GitBranch,
  GitPullRequestArrow,
  Hammer,
  Infinity as InfinityIcon,
  Languages,
  Layers,
  LifeBuoy,
  Microscope,
  Package,
  Palette,
  PencilRuler,
  Rocket,
  Server,
  ShieldAlert,
  Sparkle,
  Undo2,
  Wrench,
  Zap,
} from "lucide-react";

/** A glyph drawn beside a branch: a Lucide icon or a monochrome brand mark. */
export type BranchGlyph = ComponentType<{
  className?: string;
  strokeWidth?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

const BRANCH_TYPE_ICONS: Record<BranchTypeId, BranchGlyph> = {
  feature: Sparkle,
  bugfix: Bug,
  hotfix: Flame,
  security: ShieldAlert,
  design: PencilRuler,
  experiment: Microscope,
  refactor: Layers,
  chore: Wrench,
  docs: BookOpen,
  test: FlaskConical,
  release: Rocket,
  backport: GitPullRequestArrow,
  support: LifeBuoy,
  revert: Undo2,
  ci: InfinityIcon,
  build: Hammer,
  infra: Server,
  deps: Package,
  migration: Database,
  perf: Zap,
  style: Palette,
  i18n: Languages,
  a11y: Accessibility,
  wip: Construction,
  backup: Archive,
};

// Agents the roster already draws; any other agent namespace gets the generic bot.
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
      Icon: AGENT_NAMESPACE_ICONS.get(namespace.id) ?? Bot,
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
  isMainWorktree?: boolean;
  className?: string;
}

export function BranchLabel({
  label,
  isActive,
  isMuted,
  isMainWorktree,
  className,
}: BranchLabelProps) {
  const { displayName, Icon, rest } = useMemo(() => {
    const parts = splitBranchType(label);
    return { ...parts, rest: truncateBranchName(parts.rest, parts.displayName === null ? 40 : 36) };
  }, [label]);

  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <span className={cn("flex items-center gap-1.5 min-w-0 cursor-default", className)}>
          {Icon && displayName && (
            <span className="shrink-0 flex items-center" aria-label={displayName}>
              <Icon
                className={cn(
                  "w-3.5 h-3.5 transition-colors duration-150",
                  isMuted ? "text-text-muted" : "text-text-secondary"
                )}
                strokeWidth={2.5}
                aria-hidden="true"
              />
            </span>
          )}
          <span
            className={cn(
              "truncate font-mono transition-colors duration-150",
              isMainWorktree
                ? "text-sm leading-[inherit] font-bold tracking-wide"
                : "text-2xs font-medium",
              isActive
                ? "text-text-primary/90"
                : isMuted
                  ? "text-text-muted"
                  : "text-text-secondary"
            )}
          >
            {rest}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {displayName ? `${displayName}: ${label}` : label}
      </TooltipContent>
    </Tooltip>
  );
}
