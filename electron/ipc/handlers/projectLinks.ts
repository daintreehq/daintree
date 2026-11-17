import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { projectStore } from "../../services/ProjectStore.js";
import { PROJECT_LINKS_METHOD_CHANNELS } from "./projectLinks.preload.js";
import type {
  ProjectLinksChangePayload,
  ProjectLinksChangeResult,
} from "../../../shared/types/projectLinks.js";

// Bounds on the raw payload only; the link model trims and applies the real
// limits, so a value over them is refused with a reason rather than a throw.
const RAW_TEXT_MAX = 4_096;
const text = z.string().max(RAW_TEXT_MAX);
const id = z.string().min(1).max(200);

const ChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), title: text, url: text }).strict(),
  z.object({ op: z.literal("update"), id, title: text.optional(), url: text.optional() }).strict(),
  z
    .object({ op: z.literal("remove"), id, onlyIfAddedByAssistant: z.boolean().optional() })
    .strict(),
]);

const PayloadSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    actor: z.enum(["user", "assistant"]),
    change: ChangeSchema,
  })
  .strict();

/**
 * The project's links have this one write, so a change lands on the
 * list as it is on disk and the Assistant's ownership is checked there, where
 * a whole-settings save would replace the list from whatever copy it held.
 */
export const projectLinksNamespace = defineIpcNamespace({
  name: "projectLinks",
  ops: {
    change: opValidated(
      PROJECT_LINKS_METHOD_CHANNELS.change,
      PayloadSchema,
      async (payload: ProjectLinksChangePayload): Promise<ProjectLinksChangeResult> =>
        projectStore.changeLinks(payload.projectId, payload.actor, payload.change)
    ),
  },
});

export function registerProjectLinksHandlers(): () => void {
  return projectLinksNamespace.register();
}
