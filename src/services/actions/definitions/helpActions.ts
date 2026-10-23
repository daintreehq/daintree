import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { AgentIdSchema } from "./schemas";
import { z } from "zod";
import type { TourStartResult } from "@/components/Tour/tourRequests";
import type { TourStatus } from "@/components/Tour/tourStatus";
import { TOUR_OUTCOMES } from "@shared/utils/tourIds";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { captureHelpLaunchSnapshot, type HelpLaunchSnapshot } from "./helpLaunchSnapshot";
import type { HelpActionRunId } from "./helpActions.impl";

export type { HelpNewSessionOutcome, HelpPastSessionPickOutcome } from "./helpActions.impl";

/**
 * Run bodies load on first dispatch (#14271). Every view registers the help
 * actions at boot for menus, keybindings and the MCP manifest, but an empty
 * view runs none of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runHelpAction(
  id: HelpActionRunId,
  args: unknown,
  ctx: ActionContext,
  callbacks: ActionCallbacks,
  launch?: HelpLaunchSnapshot
): Promise<unknown> {
  const { helpActionRuns } = await import("./helpActions.impl");
  return helpActionRuns[id](args, ctx, callbacks, launch);
}

const TourStartResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), tourId: z.string(), runId: z.string() }),
  z.object({
    status: z.literal("unavailable"),
    tourId: z.string(),
    reason: z.enum(["not-registered", "no-host"]),
  }),
  z.object({ status: z.literal("failed"), tourId: z.string(), reason: z.string() }),
  z.object({ status: z.literal("superseded"), tourId: z.string() }),
]) satisfies z.ZodType<TourStartResult>;

const TourStatusSchema = z.object({
  tourId: z.string(),
  registered: z.boolean(),
  contentVersion: z.string().nullable(),
  completed: z.boolean(),
  completedCurrentVersion: z.boolean(),
  dismissed: z.boolean(),
  lastChapterId: z.string().nullable(),
  progressVersion: z.string().nullable(),
  lastOutcome: z.enum(TOUR_OUTCOMES).nullable(),
  lastRunId: z.string().nullable(),
}) satisfies z.ZodType<TourStatus>;

export function registerHelpActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("help.shortcuts", () => ({
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: (args, ctx) => runHelpAction("help.shortcuts", args, ctx, callbacks),
  }));

  actions.set("help.shortcutsAlt", () => ({
    id: "help.shortcutsAlt",
    title: "Keyboard shortcuts (Alt)",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: (args, ctx) => runHelpAction("help.shortcutsAlt", args, ctx, callbacks),
  }));

  // help.displayImage is registered here purely for manifest registration —
  // schema, description, tier, and audit metadata (#9828). Execution is handled
  // inline in the MCP CallTool handler (electron/services/mcp-server/
  // sessionServer.ts): the URL is validated against the daintree.org allowlist,
  // a figure number is assigned sequentially per help session, and the figure
  // is pushed to the pinned renderer. The tool lives only in CORE_TIER_TOOLS
  // (never the external/api-key allowlist), and the handler refuses any session
  // without a help-session id, so only help sessions can call it.
  // `run()` throws if the renderer ever invokes it directly.
  actions.set("help.displayImage", () => ({
    id: "help.displayImage",
    title: "Display documentation image",
    description:
      "Show a documentation image inline in the assistant panel, only when it genuinely illustrates the answer. Cite the returned figure label as plain text where it belongs, not as markdown image syntax, which CLI renderers strip. Never choose figure numbers yourself.",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z.object({
      url: z
        .string()
        .min(1)
        .describe("An https://daintree.org image URL. data:, blob:, and other hosts are rejected."),
      caption: z.string().optional().describe("Caption shown under the figure."),
      altText: z.string().optional().describe("Alt text for accessibility."),
    }),
    rawOutputSchema: {
      type: "object",
      properties: {
        imageId: { type: "string" },
        figureNumber: { type: "number" },
        figureLabel: { type: "string" },
      },
      required: ["imageId", "figureNumber", "figureLabel"],
    },
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    },
    examples: [
      {
        args: {
          url: "https://daintree.org/img/docs/worktree-dashboard.png",
          caption: "The worktree dashboard",
        },
        description:
          "A daintree-docs result returned this screenshot and it directly illustrates the answer — pin it, then write the returned `figureLabel` (e.g. `[image #N]`) at the relevant point in the reply.",
      },
      {
        args: { url: "https://daintree.org/img/docs/terminal-grid.png" },
        description:
          "Only call this for images that genuinely help — if a result's image is decorative or tangential to the question, do not display it.",
      },
    ],
    run: (args, ctx) => runHelpAction("help.displayImage", args, ctx, callbacks),
  }));

  actions.set("help.launchAgent", () => ({
    id: "help.launchAgent",
    title: "Launch help agent",
    description: "Open an AI agent in the help workspace folder",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["assistant", "support", "docs", "guide"],
    argsSchema: z
      .object({
        agentId: AgentIdSchema.optional(),
        // For a caller starting an assistant on someone's behalf (#13392): launch
        // into exactly this lane, and refuse rather than displace one already there.
        slot: z
          .number()
          .int()
          .min(0)
          .max(MAX_ASSISTANT_SLOTS - 1)
          .optional(),
        vacantOnly: z.boolean().optional(),
        // A fixed opening for an assistant nobody here will answer; never free text.
        greeting: z.enum(["hub"]).optional(),
      })
      .optional(),
    // The launch snapshot is read here, before the run body's chunk loads (#8317).
    run: (args, ctx) =>
      runHelpAction("help.launchAgent", args, ctx, callbacks, captureHelpLaunchSnapshot()),
  }));

  actions.set("help.newSessionWithAgent", () => ({
    id: "help.newSessionWithAgent",
    title: "New assistant session with agent",
    description:
      "Start one Daintree Assistant session on a chosen agent, leaving the default as is",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Picked from the assistant's own menus. An agent starting a help session
    // has `help.launchAgent`, which already takes an agent.
    mcpVisibility: "hidden",
    palette: { mode: "hidden" },
    keywords: ["assistant", "session", "agent", "claude", "codex"],
    argsSchema: z.object({ agentId: z.string().min(1) }),
    run: (args, ctx) => runHelpAction("help.newSessionWithAgent", args, ctx, callbacks),
  }));

  actions.set("help.resumePastSession", () => ({
    id: "help.resumePastSession",
    title: "Resume past assistant session",
    description: "Reopen an earlier Daintree Assistant conversation from this project",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // A picker over the user's own conversation history — a human affordance,
    // not something an agent should browse or drive.
    mcpVisibility: "hidden",
    keywords: ["assistant", "history", "conversation", "previous", "resume", "transcript"],
    argsSchema: z
      .object({
        agentId: z.enum(["claude", "codex"]),
        sessionId: z.string().min(1),
        slot: z.number().int().optional(),
      })
      .optional(),
    run: (args, ctx) => runHelpAction("help.resumePastSession", args, ctx, callbacks),
  }));

  actions.set("help.openCommandsFolder", () => ({
    id: "help.openCommandsFolder",
    title: "Open assistant commands folder",
    description:
      "Open the folder where custom assistant commands and skills live (~/.daintree/assistant)",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Opening an OS file-manager window is a human affordance — never
    // something an MCP agent should discover or trigger.
    mcpVisibility: "hidden",
    keywords: ["custom", "skills", "slash", "prompts", "assistant", "commands"],
    run: (args, ctx) => runHelpAction("help.openCommandsFolder", args, ctx, callbacks),
  }));

  actions.set("help.gettingStarted.show", () => ({
    id: "help.gettingStarted.show",
    title: "Getting started",
    description: "Show the getting started checklist",
    category: "help",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["onboarding", "checklist", "welcome", "tutorial"],
    run: (args, ctx) => runHelpAction("help.gettingStarted.show", args, ctx, callbacks),
  }));

  actions.set("help.tour.show", () => ({
    id: "help.tour.show",
    title: "Daintree Tour",
    description: "Play the narrated tour of Daintree's essentials",
    category: "help",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["tour", "tutorial", "walkthrough", "onboarding", "intro", "video"],
    // Optional so every existing zero-argument caller (menu, palette, MCP) keeps working.
    // An id no tour is registered under is reported in the result, not a validation error.
    argsSchema: z
      .object({
        tourId: z
          .string()
          .optional()
          .describe(
            "Tour to play; defaults to the Daintree tour. A plugin names its own tours by their manifest id"
          ),
      })
      .optional(),
    resultSchema: TourStartResultSchema,
    // Resolves once the tour is playing or can't be: how the run ends is
    // saved with its progress, read back through `help.tour.status`.
    run: (args, ctx) => runHelpAction("help.tour.show", args, ctx, callbacks),
  }));

  actions.set("help.tour.status", () => ({
    id: "help.tour.status",
    title: "Tour status",
    description:
      "Read a tour's saved progress: whether it was finished, where it resumes, and how its last run ended",
    category: "help",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    keywords: ["tour", "progress", "completed", "onboarding"],
    argsSchema: z
      .object({
        tourId: z
          .string()
          .optional()
          .describe(
            "Tour to read; defaults to the Daintree tour. A plugin names its own tours by their manifest id"
          ),
      })
      .optional(),
    resultSchema: TourStatusSchema,
    run: (args, ctx) => runHelpAction("help.tour.status", args, ctx, callbacks),
  }));

  actions.set("help.togglePanel", () => ({
    id: "help.togglePanel",
    title: "Toggle help panel",
    description: "Show or hide the help panel",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["docs", "support", "guide", "assistant"],
    run: (args, ctx) => runHelpAction("help.togglePanel", args, ctx, callbacks),
  }));
}
