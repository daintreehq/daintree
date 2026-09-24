import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { segmentRecipePrompt, type RecipeContext } from "@/utils/recipeVariables";
import { cn } from "@/lib/utils";

interface RecipeVariablePreviewProps {
  initialPrompt: string;
  worktreeId?: string;
}

// Outlines survive forced-colors, where the fill disappears, and dashed vs
// solid keeps "filled" and "empty" apart without relying on hue.
const TOKEN = "rounded-sm px-0.5 box-decoration-clone outline -outline-offset-1";
const FILLED = cn(
  TOKEN,
  "bg-category-amber-subtle text-category-amber-text outline-category-amber-border"
);
const EMPTY = cn(TOKEN, "outline-dashed text-category-rose-text outline-category-rose-border");

function formatList(names: string[]): string {
  const tokens = names.map((n) => `{{${n}}}`);
  if (tokens.length === 1) return tokens[0]!;
  return `${tokens.slice(0, -1).join(", ")} and ${tokens[tokens.length - 1]}`;
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

  return (
    <div
      className="mt-2 border-l-2 border-border-subtle pl-2.5"
      data-testid="recipe-prompt-preview"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-text-primary">Prompt preview</span>
        <span className="min-w-0 text-text-secondary wrap-anywhere">
          {source ? `Values from ${source}` : "Values fill in from the worktree at launch"}
        </span>
      </div>
      <div className="font-mono text-xs leading-relaxed text-text-primary whitespace-pre-wrap wrap-anywhere">
        {segments.map((segment, i) => {
          switch (segment.kind) {
            case "variable":
            case "value":
              return (
                <span key={i} className={FILLED} data-segment={segment.kind}>
                  {segment.text}
                </span>
              );
            case "missing":
              return (
                <span key={i} className={EMPTY} data-segment="missing">
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
          <span>
            {formatList(missing)} {missing.length === 1 ? "has" : "have"} no value in this worktree
            and {missing.length === 1 ? "launches" : "launch"} empty
          </span>
        </p>
      )}
      {unknown.length > 0 && (
        <p className="mt-1.5 text-xs text-text-secondary">
          {unknown.join(", ")}{" "}
          {unknown.length === 1 ? "isn't a recipe variable" : "aren't recipe variables"} and{" "}
          {unknown.length === 1 ? "is" : "are"} sent as typed
        </p>
      )}
    </div>
  );
}
