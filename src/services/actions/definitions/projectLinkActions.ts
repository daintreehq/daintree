import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectLink, ProjectLinkActor } from "@shared/types";
import {
  MAX_PROJECT_LINK_TITLE_LENGTH,
  MAX_PROJECT_LINK_URL_LENGTH,
  linkHost,
} from "@shared/utils/projectLinks";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { changeProjectLinks } from "@/store/projectSettingsStore";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { UnactionableTargetError } from "../unactionableTarget";

const LinkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  addedByAssistant: z.boolean(),
});

// The writes answer with the link but don't advertise its schema: the listing
// already does, and every advertised byte is paid on each Assistant turn.
const LinkResultSchema = z.object({ link: LinkSchema });

const linkId = z.string().min(1).max(200).describe("Id from the project link listing.");
const linkTitle = z
  .string()
  .min(1)
  .max(MAX_PROJECT_LINK_TITLE_LENGTH)
  .describe("Name shown for the link, e.g. Staging.");
const linkUrl = z
  .string()
  .min(1)
  .max(MAX_PROJECT_LINK_URL_LENGTH)
  .describe("https://, or http:// only for localhost or 127.0.0.1.");

const KEYWORDS = ["link", "launchpad", "launcher", "staging", "production", "dashboard", "url"];

function toResult(link: ProjectLink) {
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    addedByAssistant: link.addedByAssistant === true,
  };
}

/**
 * Who a change is made for. An agent is the Assistant only when main says the
 * session is one; any other agent is refused outright, though the tool sets
 * already keep these tools from worker panes and outside clients.
 */
function actorFor(ctx: ActionContext): ProjectLinkActor {
  if (ctx.dispatchSource === "agent") {
    if (ctx.hostCallerOrigin === "assistant") return "assistant";
    throw new UnactionableTargetError("Only the Daintree Assistant can change a project's links.");
  }
  if (ctx.dispatchSource === "plugin") {
    throw new UnactionableTargetError("A plugin can't change a project's links.");
  }
  return "user";
}

function projectFor(ctx: ActionContext): string {
  if (!ctx.projectId) {
    throw new UnactionableTargetError("No project is open in this window.");
  }
  return ctx.projectId;
}

async function undoAssistantAdd(projectId: string, link: ProjectLink): Promise<void> {
  try {
    const result = await changeProjectLinks({
      projectId,
      actor: "user",
      change: { op: "remove", id: link.id, onlyIfAddedByAssistant: true },
    });
    if (!result.saved && result.code === "not-added-by-assistant") {
      notify({
        type: "info",
        title: "Link kept",
        message: `${link.title} was edited after the Assistant added it.`,
        priority: "high",
        transient: true,
        context: { eventKind: "settings", projectId },
      });
    }
  } catch (error) {
    logError("Failed to undo a project link", error);
    notify({
      type: "error",
      title: "Couldn't remove the link",
      message: formatErrorMessage(error, "The link is still saved with the project."),
      priority: "high",
      context: { eventKind: "settings", projectId },
      action: { label: "Retry", onClick: () => void undoAssistantAdd(projectId, link) },
    });
  }
}

/**
 * Every link the Assistant adds is shown to the person, with a way straight
 * back. Kept in the inbox too, named for its project: an add made while the
 * window is blurred raises no toast, and the row says what was added where.
 */
function offerUndo(projectId: string, link: ProjectLink): void {
  notify({
    type: "info",
    title: "Assistant added a project link",
    message: `${link.title} · ${linkHost(link.url)}`,
    priority: "high",
    context: { eventKind: "agent", projectId },
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: () => void undoAssistantAdd(projectId, link),
    },
  });
}

/**
 * A project's own links (#17091), for the Daintree Assistant to fill in from
 * what it knows of the project's environments. None of these opens a page or
 * moves focus: a link is only offered wherever the project's links are shown.
 * The tool sets keep them to the Assistant, and the Assistant to the links it
 * added.
 */
export function registerProjectLinkActions(actions: ActionRegistry): void {
  actions.set("project.links.list", () =>
    defineAction({
      id: "project.links.list",
      title: "List project links",
      description:
        "List this project's links in order, with each id and whether you added it. You can change or remove only the links you added.",
      category: "project",
      kind: "query",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: KEYWORDS,
      palette: { mode: "hidden" },
      resultSchema: z.object({ links: z.array(LinkSchema) }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async (_args, ctx) => {
        const settings = await projectClient.getSettings(projectFor(ctx));
        return { links: (settings.links ?? []).map(toResult) };
      },
    })
  );

  actions.set("project.links.add", () =>
    defineAction({
      id: "project.links.add",
      title: "Add project link",
      description:
        "Add a named link, such as a staging site or CI dashboard, to this project. Opens nothing; the user sees it marked as yours, with an Undo. List first: adding twice makes two.",
      category: "project",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: [...KEYWORDS, "add", "bookmark"],
      palette: { mode: "hidden" },
      argsSchema: z.object({ title: linkTitle, url: linkUrl }),
      resultSchema: LinkResultSchema,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ title, url }, ctx) => {
        const actor = actorFor(ctx);
        const projectId = projectFor(ctx);
        const result = await changeProjectLinks({
          projectId,
          actor,
          change: { op: "add", title, url },
        });
        if (!result.saved) throw new UnactionableTargetError(result.message);
        if (actor === "assistant") offerUndo(projectId, result.link);
        return { link: toResult(result.link) };
      },
    })
  );

  actions.set("project.links.update", () =>
    defineAction({
      id: "project.links.update",
      title: "Update project link",
      description:
        "Rename or readdress a link you added to this project, under the same address rule as adding. A link the user added or has since edited is refused as theirs.",
      category: "project",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: [...KEYWORDS, "edit", "rename"],
      palette: { mode: "hidden" },
      argsSchema: z
        .object({ id: linkId, title: linkTitle.optional(), url: linkUrl.optional() })
        .refine((value) => value.title !== undefined || value.url !== undefined, {
          message: "Give a new title, url or both",
        }),
      resultSchema: LinkResultSchema,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ id, title, url }, ctx) => {
        const actor = actorFor(ctx);
        const result = await changeProjectLinks({
          projectId: projectFor(ctx),
          actor,
          change: {
            op: "update",
            id,
            ...(title !== undefined ? { title } : {}),
            ...(url !== undefined ? { url } : {}),
          },
        });
        if (!result.saved) throw new UnactionableTargetError(result.message);
        return { link: toResult(result.link) };
      },
    })
  );

  actions.set("project.links.remove", () =>
    defineAction({
      id: "project.links.remove",
      title: "Remove project link",
      description:
        "Remove a link you added from this project. A link the user added or has since edited is refused as theirs; ask them to remove it in project settings.",
      category: "project",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: [...KEYWORDS, "delete", "remove"],
      palette: { mode: "hidden" },
      argsSchema: z.object({ id: linkId }),
      resultSchema: LinkResultSchema,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ id }, ctx) => {
        const actor = actorFor(ctx);
        const result = await changeProjectLinks({
          projectId: projectFor(ctx),
          actor,
          change: { op: "remove", id },
        });
        if (!result.saved) throw new UnactionableTargetError(result.message);
        return { link: toResult(result.link) };
      },
    })
  );
}
