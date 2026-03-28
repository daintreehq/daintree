import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandStore } from "@/store/commandStore";
import { CommandPicker } from "./CommandPicker";
import { CommandBuilder } from "./CommandBuilder";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
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

  return (
    <>
      <CommandPicker
        isOpen={isPickerOpen}
        commands={commands}
        isLoading={isLoadingCommands}
        onSelect={handleSelect}
        onDismiss={closePicker}
      />

      {activeCommand && isLoadingBuilder && (
        <AppDialog isOpen={true} onClose={handleBuilderCancel} size="md">
          <AppDialog.Header>
            <AppDialog.Title>{activeCommand.label}</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <AppDialog.Body>
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <Spinner size="2xl" className="text-canopy-accent" />
              <p className="text-sm text-canopy-text/70">Loading command configuration...</p>
            </div>
          </AppDialog.Body>
        </AppDialog>
      )}

      {activeCommand && builderLoadError && (
        <AppDialog isOpen={true} onClose={handleBuilderCancel} size="md">
          <AppDialog.Header>
            <AppDialog.Title>{activeCommand.label}</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <AppDialog.Body>
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <AlertCircle className="h-12 w-12 text-status-error" />
              <div className="text-center">
                <h3 className="text-lg font-medium text-canopy-text">Failed to Load Command</h3>
                <p className="text-sm text-canopy-text/70 mt-1">{builderLoadError}</p>
              </div>
            </div>
          </AppDialog.Body>
          <AppDialog.Footer>
            <Button onClick={handleBuilderCancel}>Close</Button>
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
