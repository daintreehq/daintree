import { useCallback, useEffect, useInsertionEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useCommandStore } from "@/store/commandStore";
import { CommandPicker } from "./CommandPicker";
import { CommandBuilder } from "./CommandBuilder";
import { AppDialog } from "@/components/ui/AppDialog";
import { Spinner } from "@/components/ui/Spinner";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import type { CommandManifestEntry, CommandContext, CommandResult } from "@shared/types/commands";

interface CommandPickerHostProps {
  /**
   * The composer this host belongs to, matched against the store's
   * `pickerOwnerId`. Omitted, the host answers every opening — right only
   * where it is the one host mounted.
   */
  ownerId?: string;
  context: CommandContext;
  onCommandExecuted?: (commandId: string, result: CommandResult) => void;
}

export function CommandPickerHost({ ownerId, context, onCommandExecuted }: CommandPickerHostProps) {
  const {
    isPickerOpen: isAnyPickerOpen,
    pickerOwnerId,
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
    commandsLoadError,
    isExecuting,
    executionError,
    executeCommand,
    loadCommands,
  } = useCommandStore(
    useShallow((s) => ({
      isPickerOpen: s.isPickerOpen,
      pickerOwnerId: s.pickerOwnerId,
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
      commandsLoadError: s.commandsLoadError,
      isExecuting: s.isExecuting,
      executionError: s.executionError,
      executeCommand: s.executeCommand,
      loadCommands: s.loadCommands,
    }))
  );

  const isOwner = ownerId === undefined || pickerOwnerId === ownerId;
  const isPickerOpen = isAnyPickerOpen && isOwner;
  // The builder that follows a selection belongs to the composer that opened
  // the picker; the owner outlives the close for exactly that reason.
  const builderCommand = isOwner ? activeCommand : null;

  // The composer control that opened the picker. The picker's own restore
  // would hand focus back to it, but a builder command closes the picker and
  // opens a dialog in the same breath: that dialog records the outgoing search
  // field as its opener, and the field is gone by the time the form closes.
  // Every dialog in the chain returns here instead. Read in the insertion
  // phase, as the palette reads its own opener: by the layout phase the palette
  // has already focused its shell.
  const invokerRef = useRef<HTMLElement | null>(null);
  useInsertionEffect(() => {
    if (!isPickerOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
  }, [isPickerOpen]);
  const getInvoker = useCallback(() => invokerRef.current, []);

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
      // The form takes the keyboard from here. Without this the palette's exit
      // animation ends by focusing the composer behind the open form.
      if (command.hasBuilder) suppressPaletteFocusRestore();
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

  const handleRetryLoadCommands = useCallback(() => {
    void loadCommands(context);
  }, [loadCommands, context]);

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
        loadError={commandsLoadError}
        onRetryLoad={handleRetryLoadCommands}
        onSelect={handleSelect}
        onDismiss={closePicker}
      />

      {builderCommand && showBuilderLoading && !retryingError && (
        <AppDialog
          isOpen={true}
          onClose={handleBuilderCancel}
          size="md"
          restoreFocusTo={getInvoker}
          preferRestoreFocusTo
        >
          <AppDialog.Header>
            <AppDialog.Title>{builderCommand.label}</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <AppDialog.Body>
            <div
              className="flex flex-col items-center justify-center gap-3 py-8"
              role="status"
              aria-live="polite"
            >
              <Spinner size="xl" className="text-text-secondary" />
              <p className="text-sm text-text-secondary">Loading command…</p>
            </div>
          </AppDialog.Body>
        </AppDialog>
      )}

      {builderCommand && shownLoadError && (
        <AppDialog
          isOpen={true}
          onClose={handleBuilderCancel}
          size="md"
          restoreFocusTo={getInvoker}
          preferRestoreFocusTo
        >
          <AppDialog.Header>
            <AppDialog.Title>{builderCommand.label}</AppDialog.Title>
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
          {/* A dismissal: the recovery is the banner's Retry, and a filled Close
              would outweigh it. */}
          <AppDialog.Footer secondaryAction={{ label: "Close", onClick: handleBuilderCancel }} />
        </AppDialog>
      )}

      {builderCommand && builderSteps && !isLoadingBuilder && !builderLoadError && (
        <CommandBuilder
          command={builderCommand}
          steps={builderSteps}
          context={builderContext!}
          isExecuting={isExecuting}
          executionError={executionError}
          onExecute={handleBuilderExecute}
          onCancel={handleBuilderCancel}
          restoreFocusTo={getInvoker}
        />
      )}
    </>
  );
}
