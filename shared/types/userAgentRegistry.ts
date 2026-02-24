import { z } from "zod";
import { AgentRoutingConfigSchema } from "./agentSettings.js";

const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

export const UserAgentConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z
      .array(
        z
          .string()
          .min(1)
          .refine((arg) => !/[\r\n\0]/.test(arg), {
            message: "Args cannot contain control characters (\\r, \\n, \\0)",
          })
      )
      .optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    iconId: z.string().min(1),
    supportsContextInjection: z.boolean(),
    shortcut: z.string().nullable().optional(),
    tooltip: z.string().optional(),
    usageUrl: z.string().url().optional(),
    routing: AgentRoutingConfigSchema.optional(),
  })
  .refine((data) => !RESERVED_KEYS.includes(data.id), {
    message: "Agent ID cannot be a reserved key (__proto__, constructor, prototype)",
    path: ["id"],
  });

export type UserAgentConfig = z.infer<typeof UserAgentConfigSchema>;

export const UserAgentRegistrySchema = z.record(z.string(), UserAgentConfigSchema);

export type UserAgentRegistry = z.infer<typeof UserAgentRegistrySchema>;
