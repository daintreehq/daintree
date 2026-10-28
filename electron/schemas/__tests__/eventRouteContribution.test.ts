import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import { PLUGIN_EVENT_ROUTE_EVENTS } from "../../../shared/types/plugin.js";

const COMMAND = {
  id: "onWake",
  title: "Handle wake",
  description: "Reacts to a routed event",
  category: "Acme",
  kind: "command",
  danger: "safe",
};

function manifestWith(overrides: Record<string, unknown>) {
  return {
    name: "acme.router",
    version: "1.0.0",
    contributes: { commands: [COMMAND] },
    ...overrides,
  };
}

function errorCodes(result: { success: boolean; error?: { issues: unknown[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? "zod"
  );
}

describe("eventRoutes", () => {
  it("defaults to no routes", () => {
    const result = getPluginManifestSchema("user").safeParse(manifestWith({}));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.eventRoutes).toEqual([]);
  });

  it("accepts one route per event, several of them sharing a command", () => {
    const routes = PLUGIN_EVENT_ROUTE_EVENTS.map((event) => ({ event, command: "onWake" }));
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({ capabilities: ["agent:read"], eventRoutes: routes })
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.eventRoutes).toEqual(routes);
  });

  it("is accepted for project plugins and built-ins too", () => {
    const route = { event: "worktreeAdded", command: "onWake" };
    expect(
      getPluginManifestSchema("project").safeParse(
        manifestWith({ scope: "project", eventRoutes: [route] })
      ).success
    ).toBe(true);
    expect(
      getPluginManifestSchema("builtin").safeParse(
        manifestWith({ name: "daintree.router", eventRoutes: [route] })
      ).success
    ).toBe(true);
  });

  it("rejects an event outside the closed list and unknown route fields", () => {
    const schema = getPluginManifestSchema("user");
    expect(
      schema.safeParse(manifestWith({ eventRoutes: [{ event: "onDidWake", command: "onWake" }] }))
        .success
    ).toBe(false);
    expect(
      schema.safeParse(
        manifestWith({
          eventRoutes: [{ event: "worktreeAdded", command: "onWake", debounceMs: 0 }],
        })
      ).success
    ).toBe(false);
  });

  it("routes each event at most once", () => {
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({
        eventRoutes: [
          { event: "worktreeAdded", command: "onWake" },
          { event: "worktreeAdded", command: "onWake" },
        ],
      })
    );
    expect(errorCodes(result)).toContain("event_route_duplicate_event");
  });

  it("needs the command to be one the manifest declares, by its bare id", () => {
    const schema = getPluginManifestSchema("user");
    expect(
      errorCodes(
        schema.safeParse(
          manifestWith({ eventRoutes: [{ event: "worktreeRemoved", command: "missing" }] })
        )
      )
    ).toContain("event_route_unknown_command");
    // The namespaced id is how the command is dispatched, not how a route names it.
    expect(
      schema.safeParse(
        manifestWith({ eventRoutes: [{ event: "worktreeRemoved", command: "acme.router.onWake" }] })
      ).success
    ).toBe(false);
    expect(
      errorCodes(
        schema.safeParse(
          manifestWith({
            contributes: {},
            eventRoutes: [{ event: "worktreeRemoved", command: "onWake" }],
          })
        )
      )
    ).toContain("event_route_unknown_command");
  });

  it("refuses a command that asks for confirmation", () => {
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({
        contributes: { commands: [{ ...COMMAND, danger: "confirm" }] },
        eventRoutes: [{ event: "projectForeground", command: "onWake" }],
      })
    );
    expect(errorCodes(result)).toContain("event_route_confirm_command");
  });

  it("needs agent:read to route agentWaiting, like the live subscription", () => {
    const schema = getPluginManifestSchema("user");
    const route = { event: "agentWaiting", command: "onWake" };
    expect(errorCodes(schema.safeParse(manifestWith({ eventRoutes: [route] })))).toContain(
      "event_route_capability_required"
    );
    expect(
      schema.safeParse(manifestWith({ capabilities: ["agent:read"], eventRoutes: [route] })).success
    ).toBe(true);
  });
});
