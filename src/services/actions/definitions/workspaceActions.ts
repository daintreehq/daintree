import { z } from "zod";
import { workspaceClient } from "@/clients/workspaceClient";
import type { ActionRegistry } from "../actionTypes";

const WorkspaceSummarySchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(["project", "scratch"]),
  hasLiveView: z.boolean(),
  frontendAttached: z
    .boolean()
    .describe(
      "Whether a frontend is attached now: a view on this machine, or a Shell driving it from another. False means only the tools the host runs itself, such as launching agents and driving terminals, run here."
    ),
});

export function registerWorkspaceActions(actions: ActionRegistry): void {
  actions.set("workspace.list", () => ({
    id: "workspace.list",
    title: "List workspaces",
    description:
      "List every project and scratch workspace Daintree knows, open or not, to look up a workspace id instead of hashing a path. workspaceId is what the Daintree-Workspace-Id header binds to. hasLiveView says a view is open; only absence from this list makes an id wrong.",
    category: "workspace",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ workspaces: z.array(WorkspaceSummarySchema) }),
    mcpOutputSchema: true,
    run: async () => {
      return { workspaces: await workspaceClient.list() };
    },
  }));
}
