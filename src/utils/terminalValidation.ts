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

export async function validateTerminalConfig(
  terminal: CarrierPanel
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  const pty = isPtyPanel(terminal) ? terminal : undefined;

  // Only validate cwd for PTY panels that have it
  if (pty?.cwd) {
    try {
      const cwdExists = await systemClient.checkDirectory(pty.cwd);
      if (!cwdExists) {
        errors.push({
          type: "cwd",
          message: `Working directory does not exist: ${pty.cwd}`,
          code: "ENOENT",
          recoverable: true,
        });
      }
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to check directory");
      errors.push({
        type: "config",
        message: `Failed to validate working directory "${pty.cwd}": ${message}`,
        recoverable: true,
      });
    }
  }

  // Check agent CLI availability.
  // Launch-intent only: this runs before (or just after) launch to verify the CLI
  // the user asked for is on PATH. `detectedAgentId` doesn't exist yet at that
  // point, and using it later would validate the wrong binary for runtime-morphed
  // sessions (e.g., a plain shell that started a different agent).
  const agentId = pty?.launchAgentId;
  if (agentId && agentId !== "terminal") {
    try {
      const agentConfig = getAgentConfig(agentId);
      const cliCommand = agentConfig?.command ?? agentId;
      const cliAvailable = await systemClient.checkCommand(cliCommand);
      if (!cliAvailable) {
        errors.push({
          type: "cli",
          message: `${agentId} CLI not found in PATH`,
          recoverable: false,
        });
      }
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to check CLI");
      errors.push({
        type: "config",
        message: `Failed to validate CLI "${agentId}": ${message}`,
        recoverable: true,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function validateTerminals(
  terminals: CarrierPanel[]
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();

  await Promise.all(
    terminals.map(async (terminal) => {
      try {
        const result = await validateTerminalConfig(terminal);
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
