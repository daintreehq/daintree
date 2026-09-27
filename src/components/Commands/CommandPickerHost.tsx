import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useCommandStore } from "@/store/commandStore";
import { CommandPicker } from "./CommandPicker";
import { CommandBuilder } from "./CommandBuilder";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { CommandManifestEntry, CommandContext, CommandResult } from "@shared/types/commands";

interface CommandPickerHostProps {
  context: CommandContext;
  onCommandExecuted?: (commandId: string, result: CommandResult) => void;
}

export function CommandPickerHost({ context, onCommandExecuted }: CommandPickerHostProps) {
  const {
    isPickerOpen,
    closePicker,
    activeCommand,
    builderSteps,
    builderContext,
    isLoadingBuilder,
    builderLoadError,
    openBuilder,
    closeBuilder,
    commands,
    isLoadingCommands,
    isExecuting,
    executionError,
    executeCommand,
    loadCommands,
  } = useCommandStore(
    useShallow((s) => ({
      isPickerOpen: s.isPickerOpen,
      closePicker: s.closePicker,
      activeCommand: s.activeCommand,
      builderSteps: s.builderSteps,
      builderContext: s.builderContext,
      isLoadingBuilder: s.isLoadingBuilder,
      builderLoadError: s.builderLoadError,
      openBuilder: s.openBuilder,
      closeBuilder: s.closeBuilder,
      commands: s.commands,
      isLoadingCommands: s.isLoadingCommands,
      isExecuting: s.isExecuting,
      executionError: s.executionError,
      executeCommand: s.executeCommand,
      loadCommands: s.loadCommands,
    }))
  );

  // Sub-400ms builder loads go straight from the picker to CommandBuilder with
  // a single dialog enter animation; the spinner dialog only mounts for
  // genuinely slow loads.
  const showBuilderLoading = useDohertyGate(isLoadingBuilder);
  // A retry clears the store's load error the moment it starts, and the
  // loading dialog is gated for 400ms, so without this the dialog holding the
  // focused Retry would vanish into nothing. Hold the failure on screen, Retry
  // busy, until the reload settles one way or the other.
  const [retryingError, setRetryingError] = useState<string | null>(null);

  useEffect(() => {
    if (isPickerOpen) {
      loadCommands(context);
    }
  }, [isPickerOpen, context, loadCommands]);

  const handleSelect = useCallback(
    async (command: CommandManifestEntry) => {
      closePicker();

      if (command.hasBuilder) {
        await openBuilder(command, context);
      } else {
        const result = await executeCommand(command.id, context);
        onCommandExecuted?.(command.id, result);
      }
    },
    [closePicker, openBuilder, context, executeCommand, onCommandExecuted]
  );

  const handleBuilderExecute = useCallback(
    async (args: Record<string, unknown>) => {
      if (!activeCommand || !builderContext) {
        return {
          success: false,
          error: { code: "INVALID_STATE", message: "No active command" },
        };
      }

      const result = await executeCommand(activeCommand.id, builderContext, args);
      onCommandExecuted?.(activeCommand.id, result);
      return result;
    },
    [activeCommand, builderContext, executeCommand, onCommandExecuted]
  );

  const handleBuilderCancel = useCallback(() => {
    closeBuilder();
  }, [closeBuilder]);

  const handleBuilderRetry = useCallback(() => {
    if (!activeCommand) return;
    setRetryingError(builderLoadError);
    void openBuilder(activeCommand, builderContext ?? context).finally(() =>
      setRetryingError(null)
    );
  }, [activeCommand, builderContext, builderLoadError, context, openBuilder]);

  const shownLoadError = builderLoadError ?? retryingError;

  return (
    <>
      <CommandPicker
        isOpen={isPickerOpen}
        commands={commands}
        isLoading={isLoadingCommands}
        onSelect={handleSelect}
        onDismiss={closePicker}
      />

      {activeCommand && showBuilderLoading && !retryingError && (
        <AppDialog isOpen={true} onClose={handleBuilderCancel} size="md">
          <AppDialog.Header>
            <AppDialog.Title>{activeCommand.label}</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <AppDialog.Body>
            <div
              className="flex flex-col items-center justify-center gap-3 py-8"
              role="status"
              aria-live="polite"
            >
              <Spinner size="lg" className="text-text-secondary" />
              <p className="text-sm text-text-secondary">Loading command…</p>
            </div>
          </AppDialog.Body>
        </AppDialog>
      )}

      {activeCommand && shownLoadError && (
        <AppDialog isOpen={true} onClose={handleBuilderCancel} size="md">
          <AppDialog.Header>
            <AppDialog.Title>{activeCommand.label}</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <AppDialog.Body>
            <InlineStatusBanner
              severity="error"
              title="Couldn't load this command"
              description={shownLoadError}
              action={{
                id: "retry",
                label: "Retry",
                onClick: handleBuilderRetry,
                loading: retryingError !== null,
              }}
              animated={false}
              className="rounded-[var(--radius-md)]"
            />
          </AppDialog.Body>
          <AppDialog.Footer>
            <Button variant="contrast" onClick={handleBuilderCancel}>
              Close
            </Button>
          </AppDialog.Footer>
        </AppDialog>
      )}

      {activeCommand && builderSteps && !isLoadingBuilder && !builderLoadError && (
        <CommandBuilder
          command={activeCommand}
          steps={builderSteps}
          context={builderContext!}
          isExecuting={isExecuting}
          executionError={executionError}
          onExecute={handleBuilderExecute}
          onCancel={handleBuilderCancel}
        />
      )}
    </>
  );
}
