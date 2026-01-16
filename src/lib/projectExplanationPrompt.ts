import type { CliAvailability } from "@shared/types";

export const PROJECT_EXPLANATION_PROMPT = `You are an expert software architect analyzing this codebase for someone who needs a high-level overview.

Please analyze the project and provide a comprehensive summary in Markdown format with these sections:

## Project Name & Purpose
What does this project do? What problem does it solve?

## Tech Stack
- Languages
- Frameworks
- Key libraries and tools

## Architecture
Provide a brief map of the key directories and their purpose (e.g., src/, components/, etc.)

## Quick Start
Based on package.json, README, and project files, provide the commands to:
1. Install dependencies
2. Start the development server
3. Run tests (if applicable)

If commands aren't clearly defined in the project files, say so rather than guessing.

Keep the summary concise but informative - aim for someone to understand the project and get it running in 5 minutes.`;

export function getDefaultAgentId(
  defaultSelection: string | undefined,
  availability: CliAvailability
): "claude" | "gemini" | "codex" | "opencode" | null {
  const agentIds = ["claude", "gemini", "codex", "opencode"] as const;

  if (
    defaultSelection &&
    agentIds.includes(defaultSelection as (typeof agentIds)[number]) &&
    availability[defaultSelection as keyof CliAvailability]
  ) {
    return defaultSelection as "claude" | "gemini" | "codex" | "opencode";
  }

  for (const agentId of agentIds) {
    if (availability[agentId]) {
      return agentId;
    }
  }

  return null;
}
