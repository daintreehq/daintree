import "@/components/Layout/__preview__/bootstrap";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCommandStore } from "@/store/commandStore";
import type { CommandResult } from "@shared/types/commands";
import { CommandBuilder } from "../CommandBuilder";
import { CommandPickerHost } from "../CommandPickerHost";
import { CREATE_ISSUE } from "./commandPickerFixtures";
import { builderFixture, isBuilderFixture } from "./commandBuilderFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the command builder.
 *
 * Mounts the real `CommandBuilder` against the real theme tokens and
 * `index.css`, fed builder manifests in the shape `CommandService.getBuilder()`
 * returns, with a stand-in for the command store's execute half so each run can
 * be made to succeed, fail or never finish. The builder's own loading and
 * load-error dialogs belong to `CommandPickerHost`, so `?host=` mounts that
 * instead, with the real command store seeded into the state it would reach.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…                           built-in theme id
 *   ?fixture=create-issue|work-issue|wizard|empty     builder manifest (default create-issue)
 *   ?outcome=success|error|pending                    what executing does (default success)
 *   ?host=loading|load-error                          the host's dialogs instead of the builder
 *
 * The arguments the last execution received are mirrored onto
 * `body[data-executed-args]`.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const requested = params.get("fixture");
const fixture = isBuilderFixture(requested) ? requested : "create-issue";
const outcome = params.get("outcome") ?? "success";
const host = params.get("host");

function Builder() {
  const data = useMemo(() => builderFixture(fixture), []);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);

  const onExecute = useCallback(
    async (args: Record<string, unknown>): Promise<CommandResult> => {
      document.body.dataset.executedArgs = JSON.stringify(args);
      setIsExecuting(true);
      setExecutionError(null);
      if (outcome === "pending") return new Promise<CommandResult>(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      setIsExecuting(false);
      if (outcome === "error") {
        setExecutionError(data.failure.error?.message ?? "Command failed");
        return data.failure;
      }
      return data.success;
    },
    [data]
  );

  return (
    <CommandBuilder
      command={data.command}
      steps={data.steps}
      context={{ cwd: "/Users/dev/code/daintree" }}
      isExecuting={isExecuting}
      executionError={executionError}
      onExecute={onExecute}
      onCancel={() => {
        document.body.dataset.cancelled = "true";
      }}
    />
  );
}

function seedHost(mode: string) {
  useCommandStore.setState({
    activeCommand: CREATE_ISSUE,
    activeCommandId: CREATE_ISSUE.id,
    builderContext: { cwd: "/Users/dev/code/daintree" },
    builderSteps: null,
    isLoadingBuilder: mode === "loading",
    builderLoadError:
      mode === "load-error" ? "Command github:create-issue is not registered" : null,
  });
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    if (host) seedHost(host);
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div data-preview-shell="" className="h-screen bg-surface-canvas" />
      {host ? <CommandPickerHost context={{ cwd: "/Users/dev/code/daintree" }} /> : <Builder />}
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
