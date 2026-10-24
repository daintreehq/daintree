// Payloads a running plugin sends through the host API: toasts, notifications, panel badges and toolbar button state.

import { z } from "zod";
import {
  PANEL_MENU_MAX_ITEMS,
  PLUGIN_NOTIFY_MAX_ACTIONS,
  PLUGIN_PANEL_BADGE_LABEL_MAX,
  PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX,
} from "../../../shared/types/plugin.js";
import { PanelMenuItemSchema } from "./panels.js";

/**
 * Validates the options passed to `host.showToast`. Both the main-process path
 * (plugin `activate` code) and any future renderer path (SDK React hooks over
 * IPC) converge on this schema. `priority` and `action` are intentionally
 * absent — plugins cannot set them, so the banned `priority:"low"` +
 * `type:"error"` combo is structurally impossible. Strict so unknown fields
 * from plugin authors are rejected loudly rather than silently dropped.
 */
export const PluginToastOptionsSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    type: z.enum(["info", "success", "warning", "error"]).default("info"),
    durationMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

/** Serialized size cap for one `host.notify` action's `args`. */
const PLUGIN_NOTIFY_ARGS_MAX_BYTES = 4096;

const PluginNotifyActionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(40),
    actionId: z.string().min(1).max(200),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (args) => {
          if (args === undefined) return true;
          try {
            const json = JSON.stringify(args);
            return (
              json !== undefined &&
              new TextEncoder().encode(json).length <= PLUGIN_NOTIFY_ARGS_MAX_BYTES
            );
          } catch {
            return false;
          }
        },
        { message: `must be JSON-serializable and at most ${PLUGIN_NOTIFY_ARGS_MAX_BYTES} bytes` }
      ),
  })
  .strict();

const PluginNotifyTargetSchema = z.union([
  z.object({ panelId: z.string().min(1).max(256) }).strict(),
  z.object({ worktreeId: z.string().min(1).max(4096) }).strict(),
]);

/**
 * Validates `host.notify` options (#13505). Strict like the toast schema. The
 * action ids' namespace and the target's ownership are checked by the host,
 * which knows the caller.
 *
 * An error carries exactly one action, the same rule as the app's own error
 * toasts, and is never passive: a passive error would sit in the inbox with
 * nothing to say it happened (#13818).
 */
export const PluginNotifyOptionsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2000),
    severity: z.enum(["info", "warning", "error"]).optional(),
    delivery: z.enum(["active", "passive"]).optional(),
    target: PluginNotifyTargetSchema.optional(),
    actions: z
      .array(PluginNotifyActionSchema)
      .max(PLUGIN_NOTIFY_MAX_ACTIONS)
      .optional()
      .refine((actions) => !actions || new Set(actions.map((a) => a.id)).size === actions.length, {
        message: "action ids must be unique",
      }),
    os: z.boolean().optional(),
    dedupeKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    if (options.severity === "error" && options.actions?.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: 'an "error" notification needs exactly one action, the way out of it',
      });
    }
    if (options.delivery === "passive" && options.severity === "error") {
      ctx.addIssue({
        code: "custom",
        path: ["delivery"],
        message: 'an "error" notification can\'t be passive',
      });
    }
    if (options.delivery === "passive" && options.os === true) {
      ctx.addIssue({
        code: "custom",
        path: ["os"],
        message: "a passive notification stays in the inbox and can't page the OS",
      });
    }
  });

const PluginPanelBadgeColorSchema = z.enum(["default", "success", "warning", "error"]);

const PluginPanelBadgeTooltipSchema = z.string().trim().min(1).max(200).optional();

/**
 * Validates a `host.setPanelBadge` badge at the host boundary. Discriminated on
 * `kind`; the `label` text is rejected (not truncated) past
 * {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters so it can't overflow the
 * panel header — consistent with the reject-on-overflow convention of the other
 * length-capped strings in this file. `null` (clear) is handled at the call
 * site, not here.
 */
export const PluginPanelBadgeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dot"),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      text: z.string().trim().min(1).max(PLUGIN_PANEL_BADGE_LABEL_MAX),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
]);

const PluginToolbarButtonStateTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX)
  .optional();

/**
 * Validates a `host.setToolbarButtonState` state at the host boundary (#13785).
 * A disabled button must say why, and a reason without `disabled` is a mistake
 * rather than a no-op, so both are rejected. `null` (clear) is handled at the
 * call site, not here.
 */
export const PluginToolbarButtonRuntimeStateSchema = z
  .object({
    pressed: z.boolean().optional(),
    disabled: z.boolean().optional(),
    disabledReason: PluginToolbarButtonStateTextSchema,
    busy: z.boolean().optional(),
    tooltip: PluginToolbarButtonStateTextSchema,
    iconId: z.string().min(1).max(256).optional(),
    // Items are vetted (own namespace, no repeats) by `normalizePanelMenuItems`
    // at the call site, which also rewrites them into the instance namespace.
    menu: z.array(PanelMenuItemSchema).max(PANEL_MENU_MAX_ITEMS).optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.disabled === true && state.disabledReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "a disabled button needs a disabledReason",
      });
    }
    if (state.disabled !== true && state.disabledReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "disabledReason is only valid with disabled: true",
      });
    }
  });
