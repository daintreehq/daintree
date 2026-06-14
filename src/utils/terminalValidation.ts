import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { systemClient } from "@/clients/systemClient";
import { isPtyPanel } from "@shared/types/panel";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through until the rest of the renderer
// migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { getAgentConfig } from "@/config/agents";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export interface ValidationError {
  type: "cwd" | "cli" | "config";
  message: string;
  code?: string;
  recoverable: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationProbes {
  checkDirectory: (path: string) => Promise<boolean>;
  checkCommand: (command: string) => Promise<boolean>;
}

const directProbes: ValidationProbes = {
  checkDirectory: (path) => systemClient.checkDirectory(path),
  checkCommand: (command) => systemClient.checkCommand(command),
};

// Bulk operations validate many terminals that share a cwd and CLI; memoizing
// the probe promises per call dedupes identical IPC checks across the batch.
function createMemoizedProbes(): ValidationProbes {
  const directoryProbes = new Map<string, Promise<boolean>>();
  const commandProbes = new Map<string, Promise<boolean>>();
  return {
    checkDirectory: (path) => {
      let probe = directoryProbes.get(path);
      if (!probe) {
        probe = systemClient.checkDirectory(path);
        directoryProbes.set(path, probe);
      }
      return probe;
    },
    checkCommand: (command) => {
      let probe = commandProbes.get(command);
      if (!probe) {
        probe = systemClient.checkCommand(command);
        commandProbes.set(command, probe);
      }
      return probe;
    },
  };
}

async function validateTerminalConfigWith(
  terminal: CarrierPanel,
  probes: ValidationProbes
): Promise<ValidationResult> {
  const pty = isPtyPanel(terminal) ? terminal : undefined;

  // Only validate cwd for PTY panels that have it
  const cwd = pty?.cwd;
  const cwdCheck: Promise<ValidationError | null> = cwd
    ? probes.checkDirectory(cwd).then(
        (cwdExists): ValidationError | null =>
          cwdExists
            ? null
            : {
                type: "cwd",
                message: `Working directory does not exist: ${cwd}`,
                code: "ENOENT",
                recoverable: true,
              },
        (error): ValidationError => {
          const message = formatErrorMessage(error, "Failed to check directory");
          return {
            type: "config",
            message: `Failed to validate working directory "${cwd}": ${message}`,
            recoverable: true,
          };
        }
      )
    : Promise.resolve(null);

  // Check agent CLI availability.
  // Launch-intent only: this runs before (or just after) launch to verify the CLI
  // the user asked for is on PATH. `detectedAgentId` doesn't exist yet at that
  // point, and using it later would validate the wrong binary for runtime-morphed
  // sessions (e.g., a plain shell that started a different agent).
  const agentId = pty?.launchAgentId;
  let cliCheck: Promise<ValidationError | null> = Promise.resolve(null);
  if (agentId && agentId !== "terminal") {
    try {
      const agentConfig = getAgentConfig(agentId);
      const cliCommand = agentConfig?.command ?? agentId;
      cliCheck = probes.checkCommand(cliCommand).then(
        (cliAvailable): ValidationError | null =>
          cliAvailable
            ? null
            : {
                type: "cli",
                message: `${agentId} CLI not found in PATH`,
                recoverable: false,
              },
        (error): ValidationError => {
          const message = formatErrorMessage(error, "Failed to check CLI");
          return {
            type: "config",
            message: `Failed to validate CLI "${agentId}": ${message}`,
            recoverable: true,
          };
        }
      );
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to check CLI");
      cliCheck = Promise.resolve({
        type: "config",
        message: `Failed to validate CLI "${agentId}": ${message}`,
        recoverable: true,
      });
    }
  }

  const [cwdError, cliError] = await Promise.all([cwdCheck, cliCheck]);
  const errors = [cwdError, cliError].filter((e): e is ValidationError => e !== null);

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function validateTerminalConfig(terminal: CarrierPanel): Promise<ValidationResult> {
  return validateTerminalConfigWith(terminal, directProbes);
}

export async function validateTerminals(
  terminals: CarrierPanel[]
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();
  const probes = createMemoizedProbes();

  await Promise.all(
    terminals.map(async (terminal) => {
      try {
        const result = await validateTerminalConfigWith(terminal, probes);
        if (!result.valid) {
          results.set(terminal.id, result);
        }
      } catch (error) {
        const message = formatErrorMessage(error, "Failed to validate terminal");
        results.set(terminal.id, {
          valid: false,
          errors: [
            {
              type: "config",
              message: `Failed to validate terminal "${terminal.id}": ${message}`,
              recoverable: true,
            },
          ],
        });
      }
    })
  );

  return results;
}
