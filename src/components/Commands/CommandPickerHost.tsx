import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandStore } from "@/store/commandStore";
import { CommandPicker } from "./CommandPicker";
import { CommandBuilder } from "./CommandBuilder";
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
    openBuilder,
    closeBuilder,
    commands,
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
      openBuilder: s.openBuilder,
      closeBuilder: s.closeBuilder,
      commands: s.commands,
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
        onSelect={handleSelect}
        onDismiss={closePicker}
      />

      {activeCommand && builderSteps && (
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
