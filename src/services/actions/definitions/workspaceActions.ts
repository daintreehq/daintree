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
