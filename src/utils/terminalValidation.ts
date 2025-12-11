import type { TerminalInstance } from "@/types";
import { systemClient } from "@/clients/systemClient";

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

  const cwdExists = await systemClient.checkDirectory(terminal.cwd);
  if (!cwdExists) {
    errors.push({
      type: "cwd",
      message: `Working directory does not exist: ${terminal.cwd}`,
      code: "ENOENT",
      recoverable: true,
    });
  }

  // Check agent CLI availability
  const agentId = terminal.agentId ?? terminal.type;
  if (agentId && agentId !== "terminal") {
    const cliAvailable = await systemClient.checkCommand(agentId);
    if (!cliAvailable) {
      errors.push({
        type: "cli",
        message: `${agentId} CLI not found in PATH`,
        recoverable: false,
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
      const result = await validateTerminalConfig(terminal);
      if (!result.valid) {
        results.set(terminal.id, result);
      }
    })
  );

  return results;
}
