import type { TerminalInstance } from "@/types";
import { systemClient } from "@/clients/systemClient";
import { getAgentConfig } from "@/config/agents";

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
  terminal: TerminalInstance
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  // Only validate cwd for PTY panels that have it
  if (terminal.cwd) {
    try {
      const cwdExists = await systemClient.checkDirectory(terminal.cwd);
      if (!cwdExists) {
        errors.push({
          type: "cwd",
          message: `Working directory does not exist: ${terminal.cwd}`,
          code: "ENOENT",
          recoverable: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        type: "config",
        message: `Failed to validate working directory "${terminal.cwd}": ${message}`,
        recoverable: true,
      });
    }
  }

  // Check agent CLI availability.
  // Launch-intent only: this runs before (or just after) launch to verify the CLI
  // the user asked for is on PATH. `detectedAgentId` doesn't exist yet at that
  // point, and using it later would validate the wrong binary for runtime-morphed
  // sessions (e.g., a plain shell that started a different agent).
  const agentId = terminal.agentId;
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
      const message = error instanceof Error ? error.message : String(error);
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
  terminals: TerminalInstance[]
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
        const message = error instanceof Error ? error.message : String(error);
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
