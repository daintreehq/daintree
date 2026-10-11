import type { RecipeTerminal, TerminalRecipe } from "@shared/types/project";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Everything about one terminal that decides what runs, as the recipe in the repository says. */
function describeTerminal(terminal: RecipeTerminal): string[] {
  const lines: string[] = [];
  const head = terminal.command ?? terminal.devCommand ?? terminal.type;
  lines.push(terminal.args ? `${head} ${terminal.args}` : head);
  if (terminal.command && terminal.devCommand) lines.push(`dev server: ${terminal.devCommand}`);
  for (const [key, value] of Object.entries(terminal.env ?? {})) lines.push(`${key}=${value}`);
  if (terminal.initialPrompt) lines.push(`prompt: ${terminal.initialPrompt}`);
  return lines;
}

/**
 * Before a setup recipe that came with a cloned project runs, show the
 * person here exactly what it starts. The repository came from another
 * machine, so its commands are that machine's, not something chosen here.
 */
export function HostSetupRecipeConfirm({
  recipe,
  onAnswer,
}: {
  recipe: TerminalRecipe;
  onAnswer: (run: boolean) => void;
}) {
  return (
    <ConfirmDialog
      variant="default"
      isOpen
      onClose={() => onAnswer(false)}
      title={`Run "${recipe.name}"?`}
      description="This setup recipe came with the project from the other machine. It starts these terminals here, with these commands, settings and prompts:"
      confirmLabel="Run recipe"
      cancelLabel="Don't run"
      onConfirm={() => onAnswer(true)}
      hasPreview
      initialFocus="cancel"
    >
      <ol className="max-h-72 space-y-2 overflow-y-auto font-mono text-xs text-text-secondary select-text">
        {recipe.terminals.map((terminal, index) => (
          <li key={index} className="space-y-0.5">
            {describeTerminal(terminal).map((line, lineIndex) => (
              <p key={lineIndex} className="break-all whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </ConfirmDialog>
  );
}
