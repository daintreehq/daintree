import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Callout } from "@/components/ui/Callout";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PluginProvenance } from "./PluginProvenance";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { useRecipeStore, type RecipeSpawnResults } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getAgentConfig } from "@/config/agents";
import { recipePanelStepName } from "@/components/Terminal/utils/recipeUtils";
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import { resolveRecipeAgentStep } from "@/utils/recipeAgentStep";
import {
  pluginAgentToolsProblem,
  recipeRunNeedsAgentTools,
  type PluginAgentToolsProblem,
} from "@/utils/pluginRecipeAgentTools";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import type { RecipeContext } from "@/utils/recipeVariables";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isAgentRecipeType, type TerminalRecipe } from "@shared/types/project";
import type { PluginRunRecipeResult } from "@shared/types/plugin";
import type { PluginRunRecipeRequest, PluginUiPromptWaited } from "@shared/types/pluginUiPrompt";
import type { WorktreeSnapshot } from "@shared/types";

const EMPTY_WORKTREES: ReadonlyMap<string, WorktreeSnapshot> = new Map();

/**
 * How long a request waits for the recipe or the worktree it names to reach
 * this view before it is refused as missing. A view opened moments ago pulls
 * its plugin recipes and worktrees over separate channels, and a request that
 * beats them there is not a request for something that doesn't exist.
 */
const RUN_RECIPE_HYDRATION_GRACE_MS = 2_000;

interface StepPreview {
  index: number;
  heading: string;
  command?: string;
  args?: string;
  prompt?: string;
  systemPrompt?: string;
  envKeys: string[];
}

/**
 * Every step as it will launch: prompts with the plugin's values substituted,
 * by the same resolution the launch uses, args verbatim, and env keys with
 * their values withheld — a recipe is a plausible home for a token, and a
 * dialog is not where it belongs. A step that can't launch blocks the run.
 */
function previewSteps(
  recipe: TerminalRecipe,
  context: RecipeContext
): { steps: StepPreview[]; problem: string | null } {
  let problem: string | null = null;
  const steps = recipe.terminals.map((terminal, index): StepPreview => {
    const envKeys = Object.keys(terminal.env ?? {}).sort();
    const label = (fallback: string) =>
      terminal.title?.trim() ? `${terminal.title.trim()} (${fallback})` : fallback;
    if (terminal.type === "plugin-panel") {
      return { index, heading: `Opens ${recipePanelStepName(terminal)}`, envKeys: [] };
    }
    if (terminal.type === "dev-preview") {
      return { index, heading: label("Dev server"), command: terminal.devCommand, envKeys };
    }
    if (!isAgentRecipeType(terminal.type)) {
      return {
        index,
        heading: label("Terminal"),
        command: terminal.command ?? "(default shell)",
        envKeys,
      };
    }
    const agentName = getAgentConfig(terminal.type)?.name ?? terminal.type;
    const resolved = resolveRecipeAgentStep(recipe, terminal, terminal.type, context);
    if (!resolved.ok) {
      problem ??= `Step ${index + 1} can't start: ${resolved.reason}`;
      return { index, heading: label(agentName), args: terminal.args, envKeys };
    }
    return {
      index,
      heading: label(agentName),
      args: terminal.args,
      prompt: resolved.initialPrompt,
      systemPrompt: resolved.systemPrompt,
      envKeys,
    };
  });
  return { steps, problem };
}

/**
 * Run exactly what the dialog showed: the recipe by id AND by the digest of
 * the terminals it rendered, so a shadowing winner or a plugin reload that
 * swapped the content refuses instead of starting something unseen.
 */
async function runShownRecipe(
  recipe: TerminalRecipe,
  worktree: WorktreeSnapshot,
  context: RecipeContext
): Promise<PluginRunRecipeResult> {
  let results: RecipeSpawnResults;
  try {
    results = await useRecipeStore
      .getState()
      .runRecipeWithResults(recipe.id, worktree.path, worktree.id, context, {
        spawnedBy: "recipe",
        expectedRecipe: { id: recipe.id, terminalsDigest: recipeApprovalDigest(recipe.terminals) },
      });
  } catch (error) {
    const message = formatErrorMessage(error, "Couldn't run the recipe");
    results = {
      spawned: [],
      failed: recipe.terminals.map((_, index) => ({ index, error: message })),
    };
  }
  notifyRecipeSpawnFailures(results, { recipeName: recipe.name, worktreeId: worktree.id });
  if (results.spawned.length === 0) return { status: "refused", reason: "launch-failed" };
  return {
    status: "ran",
    spawnedCount: results.spawned.length,
    failedCount: results.failed.length,
  };
}

function openSettingsTab(tab: string): void {
  window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail: { tab } }));
}

function StepList({ steps }: { steps: StepPreview[] }) {
  return (
    <ol className="space-y-3" data-testid="plugin-run-recipe-steps">
      {steps.map((step) => (
        <li
          key={step.index}
          className="border-l-2 border-border-subtle pl-2.5 text-xs"
          data-testid="plugin-run-recipe-step"
        >
          <div className="text-sm font-medium text-text-primary wrap-anywhere">
            {step.index + 1}. {step.heading}
          </div>
          {step.command !== undefined && (
            <div className="mt-1 font-mono text-text-primary wrap-anywhere">$ {step.command}</div>
          )}
          {step.args !== undefined && (
            <div className="mt-1 text-text-secondary wrap-anywhere">
              Arguments: <span className="font-mono text-text-primary">{step.args}</span>
            </div>
          )}
          {step.systemPrompt !== undefined && (
            <div className="mt-1">
              <div className="text-text-secondary">System prompt</div>
              <div
                className="font-mono leading-relaxed text-text-primary whitespace-pre-wrap wrap-anywhere"
                data-testid="plugin-run-recipe-system-prompt"
              >
                {step.systemPrompt}
              </div>
            </div>
          )}
          {step.prompt !== undefined && (
            <div className="mt-1">
              <div className="text-text-secondary">Prompt</div>
              <div
                className="max-h-48 overflow-y-auto font-mono leading-relaxed text-text-primary whitespace-pre-wrap wrap-anywhere"
                data-testid="plugin-run-recipe-prompt"
              >
                {step.prompt}
              </div>
            </div>
          )}
          {step.envKeys.length > 0 && (
            <div className="mt-1 text-text-secondary wrap-anywhere">
              Environment: {step.envKeys.join(", ")} (values hidden)
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The host's confirmation for `host.runRecipe` (#13797). A plugin can ask to
 * run one of its own recipes; nothing starts until the user has read every
 * step with its final prompt, system prompt, arguments and environment, and
 * confirmed. Mounted once, like the other plugin prompt dialogs, and driven by
 * the front `runRecipe` prompt in `pluginPromptStore`.
 */
export function PluginRunRecipeDialog() {
  const current = usePluginPromptStore((state) => state.current);
  const resolveCurrent = usePluginPromptStore((state) => state.resolveCurrent);

  const prompt: {
    promptId: string;
    pluginId: string;
    request: PluginRunRecipeRequest;
    waited: PluginUiPromptWaited | undefined;
  } | null =
    current && current.params.kind === "runRecipe"
      ? {
          promptId: current.promptId,
          pluginId: current.pluginId,
          request: current.params.request,
          waited: current.params.waited,
        }
      : null;
  const promptId = prompt?.promptId ?? null;
  const attribution = usePluginAttribution(prompt?.pluginId ?? "");

  // Exactly the plugin's own recipe, never `getRecipeById`'s shadow winner:
  // the plugin asked for its recipe, and that is what the dialog may offer.
  const recipe = useRecipeStore((state) =>
    prompt ? (state.pluginRecipes.find((r) => r.id === prompt.request.recipeId) ?? null) : null
  );
  const worktrees = useWorktreeStoreOptional(
    (state) => (prompt ? state.worktrees : EMPTY_WORKTREES),
    EMPTY_WORKTREES
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const worktreeId = prompt?.request.worktreeId ?? activeWorktreeId ?? undefined;
  const worktree = worktreeId !== undefined ? (worktrees.get(worktreeId) ?? null) : null;

  const unavailable: "recipe-unavailable" | "unknown-worktree" | null =
    prompt === null
      ? null
      : recipe === null
        ? "recipe-unavailable"
        : worktree === null
          ? "unknown-worktree"
          : null;

  const context: RecipeContext | null =
    prompt && worktree
      ? {
          issueNumber: worktree.issueNumber,
          prNumber: worktree.linked?.pr?.ref.number,
          worktreePath: worktree.path,
          branchName: worktree.branch,
          pluginVariables: prompt.request.variables,
        }
      : null;
  const preview = recipe && context ? previewSteps(recipe, context) : null;

  const needsTools =
    recipe !== null &&
    recipeRunNeedsAgentTools(
      recipe,
      recipe.terminals.map((_, i) => i)
    );
  const [toolsCheck, setToolsCheck] = useState<{
    promptId: string;
    problem: PluginAgentToolsProblem | null;
  } | null>(null);
  const toolsPluginId = needsTools && recipe?.origin ? recipe.origin.pluginId : null;
  useEffect(() => {
    if (promptId === null || toolsPluginId === null) return;
    let cancelled = false;
    void pluginAgentToolsProblem(toolsPluginId).then((problem) => {
      if (!cancelled) setToolsCheck({ promptId, problem });
    });
    return () => {
      cancelled = true;
    };
  }, [promptId, toolsPluginId]);
  const toolsChecked = !needsTools || toolsCheck?.promptId === promptId;
  const toolsProblem = needsTools && toolsCheck?.promptId === promptId ? toolsCheck.problem : null;

  // resolveCurrent advances the queue synchronously; gate so each prompt answers once.
  const handledPromptIdRef = useRef<string | null>(null);
  const answer = useCallback(
    (value: PluginRunRecipeResult | Promise<PluginRunRecipeResult>) => {
      if (promptId === null || handledPromptIdRef.current === promptId) return;
      // `resolveCurrent` answers whichever prompt is in front. A timer or a
      // check that outlived its prompt must not answer the next one.
      if (usePluginPromptStore.getState().current?.promptId !== promptId) return;
      handledPromptIdRef.current = promptId;
      resolveCurrent(value);
    },
    [promptId, resolveCurrent]
  );

  // Nothing to show: say why rather than open an empty dialog — once the view
  // has had a moment to load what the request names.
  useEffect(() => {
    if (unavailable === null) return;
    const timer = setTimeout(
      () => answer({ status: "refused", reason: unavailable }),
      RUN_RECIPE_HYDRATION_GRACE_MS
    );
    return () => clearTimeout(timer);
  }, [unavailable, answer]);

  const isOpen = prompt !== null && unavailable === null && preview !== null;
  const stepProblem = preview !== null ? preview.problem : null;
  const blocked = toolsProblem !== null || stepProblem !== null;

  const handleClose = () => {
    if (toolsProblem !== null) answer({ status: "refused", reason: "agent-tools-off" });
    else if (stepProblem !== null) answer({ status: "refused", reason: "launch-failed" });
    else answer({ status: "cancelled" });
  };
  // Settings would open behind this modal, so the dialog answers and closes first.
  const settingsTab = toolsProblem?.settingsTab;
  const handleOpenSettings = () => {
    if (settingsTab === undefined) return;
    answer({ status: "refused", reason: "agent-tools-off" });
    openSettingsTab(settingsTab);
  };
  const handleConfirm = () => {
    if (!recipe || !worktree || !context || blocked || !toolsChecked) return;
    // A promise closes the dialog now and answers the plugin when the run
    // settles; the bridge tells main first that the run is the user's.
    answer(runShownRecipe(recipe, worktree, context));
  };

  if (!isOpen || !recipe || !preview || !worktree) {
    return (
      <ErrorBoundary variant="component" componentName="PluginRunRecipeDialog">
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Run recipe"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  const stepCount = preview.steps.length;
  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginRunRecipeDialog"
      resetKeys={[promptId ?? "null"]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={handleClose}
        title={
          <>
            Run &lsquo;{recipe.name}&rsquo;?
            {/* The footer attribution is outside the dialog's name and
                description, so assistive tech would announce the request
                without saying whose it is. */}
            <span className="sr-only"> {attribution.text}</span>
          </>
        }
        description={`Starts ${pluralize(stepCount, "step")} in ${worktree.branch || worktree.name}.`}
        confirmLabel="Run recipe"
        cancelLabel={blocked ? "Close" : "Cancel"}
        onConfirm={handleConfirm}
        confirmDisabled={blocked || !toolsChecked}
        variant="default"
        size="lg"
        hasPreview
        cooldownKey={promptId ?? undefined}
        bodyResetKey={promptId ?? undefined}
        hint={<PluginProvenance attribution={attribution} waited={prompt?.waited} />}
      >
        <div className="space-y-3">
          {toolsProblem !== null && (
            <Callout
              severity="warning"
              data-testid="plugin-run-recipe-tools-off"
              action={
                settingsTab !== undefined ? (
                  <Button variant="outline" size="sm" onClick={handleOpenSettings}>
                    Open settings
                  </Button>
                ) : undefined
              }
            >
              {toolsProblem.message}
            </Callout>
          )}
          {stepProblem !== null && (
            <Callout severity="warning" data-testid="plugin-run-recipe-step-problem">
              {stepProblem}
            </Callout>
          )}
          <StepList steps={preview.steps} />
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}
