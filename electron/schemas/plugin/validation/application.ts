import { z } from "zod";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// `application` (#14097) names one project's application and points at
// what this manifest already contributes. Every reference resolves here,
// before anything loads: one that dangles would leave the application
// pointing at nothing with no diagnostic.
export function validateApplication(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { settingsViewIds, sidebarViewIds } = context;
  const application = manifest.application;
  if (application !== undefined) {
    const issue = (path: (string | number)[], message: string, errorCode: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["application", ...path],
        message,
        params: { errorCode },
      });
    if (manifest.scope !== "project") {
      issue(
        [],
        'application is available only to a "scope": "project" plugin — an application is one project\'s, and an installed plugin is bound to no project.',
        "application_project_scope_only"
      );
    }
    // Compatibility is checked against the running app before the
    // application is put in force, so it needs a range to check.
    if (manifest.engines?.daintree === undefined) {
      issue(
        [],
        "application requires engines.daintree, so the host can tell whether this Daintree runs it before putting it in force.",
        "application_engine_required"
      );
    }
    if (
      application.destination === "home" &&
      manifest.contributes.surfaces.projectHome === undefined
    ) {
      issue(
        ["destination"],
        'application.destination "home" needs contributes.surfaces.projectHome, the Home it opens on.',
        "application_home_unclaimed"
      );
    }
    if (application.sidebarViewId !== undefined && !sidebarViewIds.has(application.sidebarViewId)) {
      issue(
        ["sidebarViewId"],
        `application.sidebarViewId "${application.sidebarViewId}" matches no contributes.views[] entry with location "sidebar".`,
        "application_sidebar_view_unknown"
      );
    }
    if (
      application.settingsViewId !== undefined &&
      !settingsViewIds.has(application.settingsViewId)
    ) {
      issue(
        ["settingsViewId"],
        `application.settingsViewId "${application.settingsViewId}" matches no contributes.views[] entry with location "settings".`,
        "application_settings_view_unknown"
      );
    }
    if (application.welcomeTour !== undefined) {
      const tour = manifest.contributes.tours.find(
        (entry) => entry.id === application.welcomeTour?.id
      );
      if (tour === undefined) {
        issue(
          ["welcomeTour", "id"],
          `application.welcomeTour.id "${application.welcomeTour.id}" matches no contributes.tours[].id.`,
          "application_tour_unknown"
        );
      } else if (tour.panelKind !== undefined) {
        issue(
          ["welcomeTour", "id"],
          `application.welcomeTour.id "${tour.id}" is a tour of the "${tour.panelKind}" panel — a welcome tour introduces the whole application, so it can't be scoped to one panel.`,
          "application_tour_panel_scoped"
        );
      }
    }
    if (application.firstWorkflow !== undefined) {
      const command = manifest.contributes.commands.find(
        (entry) => entry.id === application.firstWorkflow
      );
      if (command === undefined) {
        issue(
          ["firstWorkflow"],
          `application.firstWorkflow "${application.firstWorkflow}" matches no contributes.commands[].id.`,
          "application_command_unknown"
        );
      } else if (command.kind !== "command") {
        issue(
          ["firstWorkflow"],
          `application.firstWorkflow "${command.id}" is a query — the first workflow is something the user does, so it must be a command of kind "command".`,
          "application_command_query"
        );
      }
    }
    const agentMcpIds = new Set(manifest.contributes.agentMcp.map((endpoint) => endpoint.id));
    application.requiredTools?.forEach((tool, index) => {
      if (!agentMcpIds.has(tool)) {
        issue(
          ["requiredTools", index],
          `application.requiredTools "${tool}" matches no contributes.agentMcp[].id.`,
          "application_tool_unknown"
        );
      }
    });
  }
}
