import { create } from "zustand";
import type {
  CommandManifestEntry,
  CommandContext,
  CommandResult,
  BuilderStep,
} from "@shared/types/commands";
import { commandsClient } from "@/clients/commandsClient";

interface CommandStore {
  // Picker state
  isPickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;

  // Builder state
  activeCommand: CommandManifestEntry | null;
  activeCommandId: string | null;
  builderSteps: BuilderStep[] | null;
  builderContext: CommandContext | null;
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
  loadCommands: (context?: CommandContext) => Promise<void>;
}

export const useCommandStore = create<CommandStore>()((set, get) => ({
  // Picker state
  isPickerOpen: false,
  openPicker: () => set({ isPickerOpen: true }),
  closePicker: () => set({ isPickerOpen: false }),

  // Builder state
  activeCommand: null,
  activeCommandId: null,
  builderSteps: null,
  builderContext: null,
  openBuilder: async (command, context) => {
    set({
      activeCommand: command,
      activeCommandId: command.id,
      builderContext: context,
      builderSteps: null,
      executionError: null,
    });

    if (command.hasBuilder) {
      const commandId = command.id;
      try {
        const builder = await commandsClient.getBuilder(commandId);
        const currentCommandId = get().activeCommandId;
        if (builder && currentCommandId === commandId) {
          set({ builderSteps: builder.steps });
        }
      } catch (error) {
        console.error("Failed to fetch builder steps:", error);
      }
    }
  },
  closeBuilder: () =>
    set({
      activeCommand: null,
      activeCommandId: null,
      builderSteps: null,
      builderContext: null,
      executionError: null,
    }),

  // Execution state
  isExecuting: false,
  executionError: null,
  executeCommand: async (commandId, context, args = {}) => {
    set({ isExecuting: true, executionError: null });

    try {
      const result = await commandsClient.execute({
        commandId,
        context,
        args,
      });

      if (!result.success && result.error) {
        set({ executionError: result.error.message });
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command execution failed";
      set({ executionError: message });
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message,
        },
      };
    } finally {
      set({ isExecuting: false });
    }
  },

  // Cached commands
  commands: [],
  isLoadingCommands: false,
  loadCommands: async (context) => {
    const { isLoadingCommands } = get();
    if (isLoadingCommands) return;

    set({ isLoadingCommands: true });

    try {
      const commands = await commandsClient.list(context);
      set({ commands });
    } catch (error) {
      console.error("Failed to load commands:", error);
    } finally {
      set({ isLoadingCommands: false });
    }
  },
}));
