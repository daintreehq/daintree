import { z } from "zod";

const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

export const SAFE_AGENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const AssistantSupportsSchema = z.object({
  mcpInjection: z.enum(["project-config", "cli-flags"]),
  settingsOverlay: z.boolean(),
  permissionBypass: z.boolean(),
  trustDialog: z.boolean(),
  versionProbe: z.boolean(),
  tier: z.enum(["stable", "experimental"]),
});

export const UserAgentConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z
      .string()
      .regex(
        SAFE_AGENT_ID_PATTERN,
        "Command may only contain alphanumeric characters, dots, dashes, and underscores"
      ),
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
    supports: z.union([z.literal(false), AssistantSupportsSchema]).optional(),
  })
  .refine((data) => !RESERVED_KEYS.includes(data.id), {
    message: "Agent ID cannot be a reserved key (__proto__, constructor, prototype)",
    path: ["id"],
  });

export type UserAgentConfig = z.infer<typeof UserAgentConfigSchema>;

export const UserAgentRegistrySchema = z.record(z.string(), UserAgentConfigSchema);

export type UserAgentRegistry = z.infer<typeof UserAgentRegistrySchema>;
