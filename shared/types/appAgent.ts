import { z } from "zod";
import { resolveAppAgentChatCompletionsUrl } from "../utils/appAgentUrl.js";

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
  // Field-level so the refinement survives `.partial()` in the set-config handler.
  baseUrl: z
    .string()
    .refine((value) => resolveAppAgentChatCompletionsUrl(value).ok)
    .optional(),
  enabled: z.boolean().optional(),
});

export type AppAgentConfig = z.infer<typeof AppAgentConfigSchema>;

export const DEFAULT_APP_AGENT_CONFIG: AppAgentConfig = {
  provider: "fireworks",
  model: "accounts/fireworks/models/kimi-k2p5",
};
