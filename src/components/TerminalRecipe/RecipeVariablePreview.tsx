import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import {
  replaceRecipeVariables,
  detectUnresolvedVariables,
  splitByRecipeVariables,
  type RecipeContext,
} from "@/utils/recipeVariables";

interface RecipeVariablePreviewProps {
  initialPrompt: string;
  worktreeId?: string;
}

export function RecipeVariablePreview({ initialPrompt, worktreeId }: RecipeVariablePreviewProps) {
  const worktreeSnap = useWorktreeStore((state) =>
    worktreeId ? state.worktrees.get(worktreeId) : undefined
  );

  const context: RecipeContext = useMemo(() => {
    if (!worktreeSnap) {
      return {};
    }
    return {
      issueNumber: worktreeSnap.issueNumber,
      prNumber: worktreeSnap.linked?.pr?.ref.number,
      worktreePath: worktreeSnap.path,
      branchName: worktreeSnap.branch,
    };
  }, [worktreeSnap]);

  const hasContext = worktreeSnap !== undefined;

  if (!initialPrompt) return null;

  const unresolvedVars = detectUnresolvedVariables(initialPrompt, context);
  const resolvedText = hasContext ? replaceRecipeVariables(initialPrompt, context) : null;

  return (
    <div className="mt-2 border-l-2 border-border-subtle pl-2.5 transition-colors">
      <div className="text-xs font-medium text-daintree-text mb-1">Resolved prompt</div>
      <div className="text-xs leading-relaxed text-daintree-text/80 break-all whitespace-pre-wrap font-mono">
        {hasContext && resolvedText !== null
          ? resolvedText
          : splitByRecipeVariables(initialPrompt).map((part, i) =>
              part.isVar ? (
                <span
                  key={i}
                  className="inline rounded-sm bg-category-amber-subtle px-0.5 text-category-amber-text"
                >
                  {part.text}
                </span>
              ) : (
                <span key={i}>{part.text}</span>
              )
            )}
      </div>
      {!hasContext && <p className="text-[10px] text-text-muted mt-1">Resolving at run time</p>}
      {hasContext && unresolvedVars.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {unresolvedVars.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] bg-category-rose-subtle text-category-rose-text"
            >
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
              {`{{${name}}}`} unresolved
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
