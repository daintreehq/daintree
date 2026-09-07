import { z } from "zod";
import { workspaceClient } from "@/clients/workspaceClient";
import type { ActionRegistry } from "../actionTypes";

const WorkspaceSummarySchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(["project", "scratch"]),
  hasLiveView: z.boolean(),
});

export function registerWorkspaceActions(actions: ActionRegistry): void {
  actions.set("workspace.list", () => ({
    id: "workspace.list",
    title: "List Workspaces",
    description:
      "List every project and scratch Daintree knows about, open or not, so a client can look up a workspace id rather than derive one by hashing a path. workspaceId is what the Daintree-Workspace-Id header binds to; kind is project or scratch. hasLiveView says whether a view is open, not whether an id is valid — absence from this list is what makes an id wrong.",
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
