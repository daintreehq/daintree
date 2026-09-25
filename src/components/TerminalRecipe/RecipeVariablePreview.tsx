import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { segmentRecipePrompt, type RecipeContext } from "@/utils/recipeVariables";
import {
  RECIPE_VARIABLE_EMPTY_TOKEN,
  RECIPE_VARIABLE_TOKEN,
} from "@/components/TerminalRecipe/recipeVariableTokens";

interface RecipeVariablePreviewProps {
  initialPrompt: string;
  worktreeId?: string;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function unique(names: string[]): string[] {
  return Array.from(new Set(names));
}

export function RecipeVariablePreview({ initialPrompt, worktreeId }: RecipeVariablePreviewProps) {
  const worktreeSnap = useWorktreeStore((state) =>
    worktreeId ? state.worktrees.get(worktreeId) : undefined
  );

  const context: RecipeContext | null = useMemo(() => {
    if (!worktreeSnap) return null;
    return {
      issueNumber: worktreeSnap.issueNumber,
      prNumber: worktreeSnap.linked?.pr?.ref.number,
      worktreePath: worktreeSnap.path,
      branchName: worktreeSnap.branch,
    };
  }, [worktreeSnap]);

  const segments = segmentRecipePrompt(initialPrompt, context);
  // Nothing to preview when the prompt has no {{…}} at all: it would only
  // repeat the field above it.
  if (!segments.some((s) => s.kind !== "text")) return null;

  const missing = unique(segments.flatMap((s) => (s.kind === "missing" ? [s.name] : [])));
  const unknown = unique(segments.flatMap((s) => (s.kind === "unknown" ? [s.text] : [])));
  const source = worktreeSnap ? (worktreeSnap.branch ?? worktreeSnap.name) : null;
  const substitutes = segments.some((s) => s.kind !== "text" && s.kind !== "unknown");

  return (
    <div
      className="mt-2 border-l-2 border-border-subtle pl-2.5"
      data-testid="recipe-prompt-preview"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-text-primary">Prompt preview</span>
        {substitutes && (
          <span className="min-w-0 text-text-secondary wrap-anywhere">
            {source ? `Values from ${source}` : "Values fill in from the worktree at launch"}
          </span>
        )}
      </div>
      <div className="font-mono text-xs leading-relaxed text-text-primary whitespace-pre-wrap wrap-anywhere">
        {segments.map((segment, i) => {
          switch (segment.kind) {
            case "variable":
            case "value":
              return (
                <span key={i} className={RECIPE_VARIABLE_TOKEN} data-segment={segment.kind}>
                  {segment.text}
                </span>
              );
            case "missing":
              return (
                <span key={i} className={RECIPE_VARIABLE_EMPTY_TOKEN} data-segment="missing">
                  {segment.text}
                  <span className="sr-only"> (empty)</span>
                </span>
              );
            case "unknown":
              return (
                <span
                  key={i}
                  className="underline decoration-dotted decoration-text-secondary underline-offset-2"
                  data-segment="unknown"
                >
                  {segment.text}
                </span>
              );
            default:
              return <span key={i}>{segment.text}</span>;
          }
        })}
      </div>
      {missing.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-category-rose-text">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 wrap-anywhere">
            {formatList(missing.map((n) => `{{${n}}}`))} {missing.length === 1 ? "has" : "have"} no
            value in this worktree and {missing.length === 1 ? "launches" : "launch"} empty
          </span>
        </p>
      )}
      {unknown.length > 0 && (
        <p className="mt-1.5 text-xs text-text-secondary wrap-anywhere">
          {formatList(unknown)}{" "}
          {unknown.length === 1 ? "isn't a recipe variable" : "aren't recipe variables"} and{" "}
          {unknown.length === 1 ? "is" : "are"} sent as typed
        </p>
      )}
    </div>
  );
}
