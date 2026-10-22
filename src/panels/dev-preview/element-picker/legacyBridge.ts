// The picker still talks to the sveltekit-builder plugin's main side, so its
// wire contract stays the plugin's until the host takes source resolution over
// (#13874) and the switch-over drops the plugin (#13886). Every reach into the
// plugin goes through this file.
export {
  CHANNELS,
  ComponentDefinitionsResultSchema,
  GUEST_ADAPTER_ID,
  GuestEventSchema,
  IssuePushSchema,
  PLUGIN_ID,
  ProjectModelResultSchema,
  PUSH_CHANNELS,
  SelectionResolveResultSchema,
  SourceChangedPushSchema,
  SourceRevisionsResultSchema,
  WorkspaceOpenResultSchema,
  BUILDER_TOOL_ID as LEGACY_TOOL_ID,
  singleLineLabel,
} from "../../../../plugins/builtin/sveltekit-builder/shared/protocol.js";
export type {
  ElementContext,
  ProjectModel,
  RouteNode,
  SelectionMismatch,
  SupportVerdict,
} from "../../../../plugins/builtin/sveltekit-builder/shared/protocol.js";
export type {
  AncestryEntry,
  SelectedNode,
  SiteSelection,
  Viewport,
} from "../../../../plugins/builtin/sveltekit-builder/shared/model.js";
export { redactUrl } from "../../../../plugins/builtin/sveltekit-builder/shared/redactUrl.js";
export { untestedVersionNotes } from "../../../../plugins/builtin/sveltekit-builder/shared/project/versions.js";

export const loadRouteMatch = () =>
  import("../../../../plugins/builtin/sveltekit-builder/shared/project/routeMatch.js");
