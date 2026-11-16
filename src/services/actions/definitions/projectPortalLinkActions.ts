import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectPortalLink, ProjectPortalLinkActor } from "@shared/types";
import {
  MAX_PROJECT_PORTAL_LINK_TITLE_LENGTH,
  MAX_PROJECT_PORTAL_LINK_URL_LENGTH,
  portalLinkHost,
} from "@shared/utils/projectPortalLinks";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { changeProjectPortalLinks } from "@/store/projectSettingsStore";
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

const LinkResultSchema = z.object({ link: LinkSchema });

const linkId = z.string().min(1).max(200).describe("Link id from the project link listing.");
const linkTitle = z
  .string()
  .min(1)
  .max(MAX_PROJECT_PORTAL_LINK_TITLE_LENGTH)
  .describe("Name shown in the launchpad, such as Staging.");
const linkUrl = z
  .string()
  .min(1)
  .max(MAX_PROJECT_PORTAL_LINK_URL_LENGTH)
  .describe("An https:// address, or http:// for localhost or 127.0.0.1 only.");

const KEYWORDS = ["portal", "link", "launchpad", "staging", "production", "dashboard", "url"];

function toResult(link: ProjectPortalLink) {
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
function actorFor(ctx: ActionContext): ProjectPortalLinkActor {
  if (ctx.dispatchSource === "agent") {
    if (ctx.hostCallerOrigin === "assistant") return "assistant";
    throw new UnactionableTargetError(
      "Only the Daintree Assistant can change a project's Portal links."
    );
  }
  if (ctx.dispatchSource === "plugin") {
    throw new UnactionableTargetError("A plugin can't change a project's Portal links.");
  }
  return "user";
}

function projectFor(ctx: ActionContext): string {
  if (!ctx.projectId) {
    throw new UnactionableTargetError("No project is open in this window.");
  }
  return ctx.projectId;
}

async function undoAssistantAdd(projectId: string, link: ProjectPortalLink): Promise<void> {
  try {
    const result = await changeProjectPortalLinks({
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
      });
    }
  } catch (error) {
    logError("Failed to undo a project Portal link", error);
    notify({
      type: "error",
      title: "Couldn't remove the link",
      message: formatErrorMessage(error, "The link is still in the launchpad."),
      action: { label: "Retry", onClick: () => void undoAssistantAdd(projectId, link) },
    });
  }
}

/** Every link the Assistant adds is shown to the person, with a way straight back. */
function offerUndo(projectId: string, link: ProjectPortalLink): void {
  notify({
    type: "info",
    title: "Assistant added a Portal link",
    message: `${link.title} · ${portalLinkHost(link.url)}`,
    priority: "high",
    transient: true,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: () => void undoAssistantAdd(projectId, link),
    },
  });
}

/**
 * A project's own Portal launchpad links (#17091), for the Daintree Assistant
 * to fill in from what it knows of the project's environments. None of these
 * opens a tab, shows the Portal or moves focus: a link is only offered in the
 * launchpad. The tool sets keep them to the Assistant, and the Assistant to
 * the links it added.
 */
export function registerProjectPortalLinkActions(actions: ActionRegistry): void {
  actions.set("portal.projectLinks.list", () =>
    defineAction({
      id: "portal.projectLinks.list",
      title: "List project Portal links",
      description:
        "List the links saved with this project for its Portal launchpad, in order, with each id and whether the Assistant added it. Only a link the Assistant added can be changed or removed by it.",
      category: "portal",
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
        return { links: (settings.portalLinks ?? []).map(toResult) };
      },
    })
  );

  actions.set("portal.projectLinks.add", () =>
    defineAction({
      id: "portal.projectLinks.add",
      title: "Add project Portal link",
      description:
        "Add a named link, such as the staging site, production site or CI dashboard, to this project's Portal launchpad. Opens nothing. The user sees it marked as yours, with an Undo. Not an upsert: list first so a link isn't added twice.",
      category: "portal",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: [...KEYWORDS, "add", "bookmark"],
      palette: { mode: "hidden" },
      argsSchema: z.object({ title: linkTitle, url: linkUrl }),
      resultSchema: LinkResultSchema,
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ title, url }, ctx) => {
        const actor = actorFor(ctx);
        const projectId = projectFor(ctx);
        const result = await changeProjectPortalLinks({
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

  actions.set("portal.projectLinks.update", () =>
    defineAction({
      id: "portal.projectLinks.update",
      title: "Update project Portal link",
      description:
        "Rename or readdress a link you added to this project's Portal launchpad, under the same address rule as adding. A link the user added, or edited since, is refused as theirs.",
      category: "portal",
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
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ id, title, url }, ctx) => {
        const actor = actorFor(ctx);
        const result = await changeProjectPortalLinks({
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

  actions.set("portal.projectLinks.remove", () =>
    defineAction({
      id: "portal.projectLinks.remove",
      title: "Remove project Portal link",
      description:
        "Remove a link you added from this project's Portal launchpad. A link the user added, or edited since, is refused as theirs: ask them to remove it in project settings.",
      category: "portal",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      keywords: [...KEYWORDS, "delete", "remove"],
      palette: { mode: "hidden" },
      argsSchema: z.object({ id: linkId }),
      resultSchema: LinkResultSchema,
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      run: async ({ id }, ctx) => {
        const actor = actorFor(ctx);
        const result = await changeProjectPortalLinks({
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
