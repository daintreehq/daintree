import { z } from "zod";

export const AppAgentProviderSchema = z.enum([
  "fireworks",
  "openai",
  "anthropic",
  "openaiCompatible",
]);
export type AppAgentProvider = z.infer<typeof AppAgentProviderSchema>;

export const AppAgentConfigSchema = z.object({
  provider: AppAgentProviderSchema,
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export type AppAgentConfig = z.infer<typeof AppAgentConfigSchema>;

export const DEFAULT_APP_AGENT_CONFIG: AppAgentConfig = {
  provider: "fireworks",
  model: "accounts/fireworks/models/kimi-k2p5",
};

export const AgentDecisionDispatchSchema = z.object({
  type: z.literal("dispatch"),
  id: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const AgentDecisionAskSchema = z.object({
  type: z.literal("ask"),
  question: z.string(),
  choices: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
    })
  ),
});

export const AgentDecisionReplySchema = z.object({
  type: z.literal("reply"),
  text: z.string(),
});

export const AgentDecisionSchema = z.discriminatedUnion("type", [
  AgentDecisionDispatchSchema,
  AgentDecisionAskSchema,
  AgentDecisionReplySchema,
]);

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type AgentDecisionDispatch = z.infer<typeof AgentDecisionDispatchSchema>;
export type AgentDecisionAsk = z.infer<typeof AgentDecisionAskSchema>;
export type AgentDecisionReply = z.infer<typeof AgentDecisionReplySchema>;

export interface OneShotRunRequest {
  prompt: string;
  clarificationChoice?: string;
  maxTurns?: number; // Default 10
}

export interface OneShotRunResult {
  success: boolean;
  decision?: AgentDecision;
  error?: string;
  traceId?: string;
  rawModelOutput?: string;
  turnsUsed?: number; // Track iteration count
  totalToolCalls?: number; // Track function call count
}

export const AGENT_ACCESSIBLE_ACTIONS = [
  // Query actions - return system state
  "terminal.list",
  "terminal.getOutput",
  "panel.list",
  "worktree.list",
  "worktree.getCurrent",
  "project.getCurrent",
  // Command actions - perform operations
  "app.settings",
  "app.settings.openTab",
  "terminal.new",
  "terminal.kill",
  "terminal.close",
  "terminal.trash",
  "terminal.palette",
  "worktree.createDialog.open",
  "worktree.setActive",
  "agent.launch",
  "nav.toggleSidebar",
  "panel.toggleDock",
  "sidecar.toggle",
] as const;

export type AgentAccessibleAction = (typeof AGENT_ACCESSIBLE_ACTIONS)[number];
