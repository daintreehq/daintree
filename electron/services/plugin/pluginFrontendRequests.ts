import { z } from "zod";
import {
  PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS,
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS,
} from "../../../shared/types/pluginCapabilityConsent.js";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "../../../shared/types/plugin.js";
import type { PluginQuickPickItem } from "../../../shared/types/plugin.js";
import type {
  PluginUiPromptParams,
  PluginUiPromptResultValue,
} from "../../../shared/types/pluginUiPrompt.js";

/**
 * Reverse requests a host sends the Shell whose view drives a project, for the
 * plugin calls that need a person. The Shell validates every payload against
 * these schemas and scopes it to the view's own project before acting; the
 * host validates every answer before handing it to the plugin.
 */
export const PluginFrontendMethod = {
  /** Show a quick pick / input box / confirm; answers the person's value. */
  PROMPT: "plugin.prompt",
  /** Take an open prompt (or all of a plugin's) off the screen. */
  PROMPT_CANCEL: "plugin.prompt-cancel",
  /** First-use capability consent; answers a consent outcome. */
  CONSENT: "plugin.capability-consent",
  /** The driving machine's clipboard. */
  CLIPBOARD: "plugin.clipboard",
  /** A plugin toast, shown in the driving view. */
  TOAST: "plugin.toast",
} as const;

/** A remote clipboard image must fit one link frame with room to spare. */
/** The clipboard call itself, once the person has said yes. */
const REMOTE_CLIPBOARD_CALL_MS = 15_000;

/**
 * How long a host waits for a Shell's clipboard answer. A plugin's first use
 * waits on the Shell's consent dialog (its delivery receipt plus the person's
 * decision), so the wait covers that whole exchange and the call after it.
 */
export const REMOTE_CLIPBOARD_TIMEOUT_MS =
  PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS +
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS +
  REMOTE_CLIPBOARD_CALL_MS;

/**
 * How long a Shell may take before touching its clipboard for a host's call:
 * the host's wait less a margin, so it never acts on a call the host has
 * already given up on.
 */
export const REMOTE_CLIPBOARD_SHELL_BUDGET_MS = REMOTE_CLIPBOARD_TIMEOUT_MS - 5_000;

export const REMOTE_CLIPBOARD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const REMOTE_CLIPBOARD_TEXT_MAX_BYTES = 8 * 1024 * 1024;

const shortText = z.string().max(4096);
const longText = z.string().max(64 * 1024);
const pluginId = z.string().min(1).max(256);

const QuickPickItemSchema = z.object({
  id: z.string().min(1).max(1024),
  label: z.string().max(4096),
  description: shortText.optional(),
  detail: shortText.optional(),
});

const PromptParamsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("quickPick"),
    items: z.array(QuickPickItemSchema).max(10_000),
    options: z.object({
      title: shortText.optional(),
      placeholder: shortText.optional(),
      canSelectMany: z.boolean().optional(),
      matchOnDescription: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal("inputBox"),
    options: z.object({
      title: shortText.optional(),
      prompt: longText.optional(),
      placeholder: shortText.optional(),
      value: longText.optional(),
      password: z.boolean().optional(),
      validationPattern: shortText.optional(),
      validationMessage: shortText.optional(),
    }),
  }),
  z.object({
    kind: z.literal("confirm"),
    options: z.object({
      title: shortText,
      message: longText.optional(),
      confirmLabel: shortText.optional(),
      cancelLabel: shortText.optional(),
      destructive: z.boolean().optional(),
    }),
  }),
]);

export const PluginPromptPayloadSchema = z.object({
  /** The host's id for this prompt; names it in a later cancel. */
  promptId: z.string().min(1).max(128),
  pluginId,
  pluginDisplayName: z.string().min(1).max(256),
  params: PromptParamsSchema,
  /** Epoch ms the plugin asked, when the prompt waited for someone to attach. */
  askedAt: z.number().int().nonnegative().optional(),
});
export type PluginPromptPayload = z.infer<typeof PluginPromptPayloadSchema>;

export const PluginPromptCancelPayloadSchema = z.object({
  pluginId,
  promptId: z.string().min(1).max(128).optional(),
});
export type PluginPromptCancelPayload = z.infer<typeof PluginPromptCancelPayloadSchema>;

export const PluginConsentPayloadSchema = z.object({
  pluginId,
  pluginDisplayName: z.string().min(1).max(256),
  capability: z.enum(BUILT_IN_PLUGIN_CAPABILITIES),
  declaredCapabilities: z.array(z.enum(BUILT_IN_PLUGIN_CAPABILITIES)).max(64),
});
export type PluginConsentPayload = z.infer<typeof PluginConsentPayloadSchema>;

export const PluginConsentOutcomeSchema = z.enum([
  "approved-once",
  "approved-and-pin",
  "rejected",
  "timeout",
  "undeliverable",
]);

export const PluginToastPayloadSchema = z.object({
  pluginId,
  type: z.enum(["info", "success", "warning", "error"]),
  /** Already prefixed with the plugin's name by the host. */
  message: z.string().min(1).max(2400),
  durationMs: z.number().int().positive().max(60_000).optional(),
});
export type PluginToastPayload = z.infer<typeof PluginToastPayloadSchema>;

export const PluginClipboardPayloadSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("writeText"), pluginId, text: z.string() }),
  z.object({
    op: z.literal("writeImage"),
    pluginId,
    png: z.instanceof(Uint8Array),
  }),
  z.object({ op: z.literal("readText"), pluginId }),
]);
export type PluginClipboardPayload = z.infer<typeof PluginClipboardPayloadSchema>;

/**
 * The value a Shell answered a prompt with, re-derived from what the host
 * offered. A quick pick answer is matched back to the host's own items by id,
 * so nothing the Shell invents reaches the plugin; anything that doesn't fit
 * the prompt's kind is the dismiss value.
 */
export function coercePromptAnswer(
  params: PluginUiPromptParams,
  answer: unknown
): PluginUiPromptResultValue {
  switch (params.kind) {
    case "confirm":
      return answer === true;
    case "inputBox":
      return typeof answer === "string" ? answer : undefined;
    case "quickPick": {
      const byId = new Map<string, PluginQuickPickItem>(params.items.map((i) => [i.id, i]));
      const pick = (value: unknown): PluginQuickPickItem | undefined => {
        if (!value || typeof value !== "object") return undefined;
        const id = (value as { id?: unknown }).id;
        return typeof id === "string" ? byId.get(id) : undefined;
      };
      if (params.options.canSelectMany) {
        if (answer === undefined) return undefined;
        if (!Array.isArray(answer)) return undefined;
        const picked: PluginQuickPickItem[] = [];
        const seen = new Set<string>();
        for (const value of answer) {
          const item = pick(value);
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          picked.push(item);
        }
        return picked;
      }
      return pick(answer);
    }
  }
}
