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
  enabled: z.boolean().optional(),
});

export type AppAgentConfig = z.infer<typeof AppAgentConfigSchema>;

export const DEFAULT_APP_AGENT_CONFIG: AppAgentConfig = {
  provider: "fireworks",
  model: "accounts/fireworks/models/kimi-k2p5",
};
