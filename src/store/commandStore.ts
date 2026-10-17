import { create } from "zustand";
import type {
  CommandManifestEntry,
  CommandContext,
  CommandResult,
  BuilderStep,
} from "@shared/types/commands";
import { commandsClient } from "@/clients/commandsClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

interface CommandStore {
  // Picker state
  isPickerOpen: boolean;
  /**
   * The composer that opened the picker. Every agent pane mounts its own
   * `CommandPickerHost` against this one store, so without an owner each of
   * them opened a palette (and later a builder) at once, and a selection ran
   * with whichever pane's context its palette belonged to. Kept through close:
   * the builder that follows a selection belongs to the same composer.
   */
  pickerOwnerId: string | null;
  openPicker: (ownerId?: string) => void;
  closePicker: () => void;

  // Builder state
  activeCommand: CommandManifestEntry | null;
  activeCommandId: string | null;
  builderSteps: BuilderStep[] | null;
  builderContext: CommandContext | null;
  isLoadingBuilder: boolean;
  builderLoadError: string | null;
  openBuilder: (command: CommandManifestEntry, context: CommandContext) => Promise<void>;
  closeBuilder: () => void;

  // Execution state
  isExecuting: boolean;
  executionError: string | null;
  executeCommand: (
    commandId: string,
    context: CommandContext,
    args?: Record<string, unknown>
  ) => Promise<CommandResult>;

  // Cached commands
  commands: CommandManifestEntry[];
  isLoadingCommands: boolean;
  /** Why the last list request failed; cleared when the next one starts. */
  commandsLoadError: string | null;
  loadCommands: (context?: CommandContext) => Promise<void>;
}

// Bumped whenever the builder a run belongs to goes away. A run that settles
// after that still reports its result to whoever awaited it, but must not
// write its pending or error state into a builder opened since.
let runGeneration = 0;
// The same for builder loads: a response for an opening that has since been
// closed, or superseded by reopening the same command, is dropped. Keyed on the
// opening, not the command id, which a reopen shares.
let loadGeneration = 0;

export const useCommandStore = create<CommandStore>()((set, get) => ({
  // Picker state
  isPickerOpen: false,
  pickerOwnerId: null,
  openPicker: (ownerId) => set({ isPickerOpen: true, pickerOwnerId: ownerId ?? null }),
  closePicker: () => set({ isPickerOpen: false }),

  // Builder state
  activeCommand: null,
  activeCommandId: null,
  builderSteps: null,
  builderContext: null,
  isLoadingBuilder: false,
  builderLoadError: null,
  openBuilder: async (command, context) => {
    set({
      activeCommand: command,
      activeCommandId: command.id,
      builderContext: context,
      builderSteps: null,
      executionError: null,
      isLoadingBuilder: true,
      builderLoadError: null,
    });

    const generation = ++loadGeneration;
    if (command.hasBuilder) {
      const commandId = command.id;
      try {
        const builder = await commandsClient.getBuilder(commandId);
        if (generation === loadGeneration) {
          if (builder) {
            set({ builderSteps: builder.steps, isLoadingBuilder: false });
          } else {
            set({
              builderLoadError: "Failed to load command configuration",
              isLoadingBuilder: false,
            });
          }
        }
      } catch (error) {
        const message = formatErrorMessage(error, "Failed to load builder");
        logError("Failed to fetch builder steps", error);
        if (generation === loadGeneration) {
          set({ builderLoadError: message, isLoadingBuilder: false });
        }
      }
    } else {
      set({ isLoadingBuilder: false });
    }
  },
  closeBuilder: () => {
    runGeneration++;
    loadGeneration++;
    set({
      activeCommand: null,
      activeCommandId: null,
      builderSteps: null,
      builderContext: null,
      isExecuting: false,
      executionError: null,
      isLoadingBuilder: false,
      builderLoadError: null,
    });
  },

  // Execution state
  isExecuting: false,
  executionError: null,
  executeCommand: async (commandId, context, args = {}) => {
    set({ isExecuting: true, executionError: null });
    const generation = runGeneration;
    const isCurrent = () => generation === runGeneration;

    try {
      const result = await commandsClient.execute({
        commandId,
        context,
        args,
      });

      if (!result.success && isCurrent()) {
        // A failure without error details still has to show as one.
        set({
          executionError: result.error?.message ?? result.message ?? "The command didn't finish.",
        });
      }

      return result;
    } catch (error) {
      const message = formatErrorMessage(error, "Command execution failed");
      if (isCurrent()) set({ executionError: message });
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message,
        },
      };
    } finally {
      if (isCurrent()) set({ isExecuting: false });
    }
  },

  // Cached commands
  commands: [],
  isLoadingCommands: false,
  commandsLoadError: null,
  loadCommands: async (context) => {
    const { isLoadingCommands } = get();
    if (isLoadingCommands) return;

    set({ isLoadingCommands: true, commandsLoadError: null });

    try {
      const commands = await commandsClient.list(context);
      set({ commands });
    } catch (error) {
      logError("Failed to load commands", error);
      set({ commandsLoadError: formatErrorMessage(error, "Couldn't load commands") });
    } finally {
      set({ isLoadingCommands: false });
    }
  },
}));
