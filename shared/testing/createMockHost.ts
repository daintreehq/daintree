// The public `createMockHost`, composed from the in-memory facets under
// `./mockHost/`. The doc on what it is and why its return type is an
// intersection lives on the types it returns, in `./mockHost/types.ts`.

import { createContributionsFacet } from "./mockHost/contributions.js";
import { createFilesFacet } from "./mockHost/files.js";
import { createMockIdentity } from "./mockHost/identity.js";
import { createPresentationFacet } from "./mockHost/presentation.js";
import { createSettingsFacet } from "./mockHost/settings.js";
import { createWorkspaceFacet } from "./mockHost/workspace.js";
import type { PluginHostApi } from "../types/plugin.js";
import type { CreateMockHostOptions, MockHostState } from "./mockHost/types.js";

export type {
  RegisteredActionRecord,
  RegisteredHandlerRecord,
  BroadcastRecord,
  PostToPanelRecord,
  ShownToastRecord,
  NotificationRecord,
  MockTaskRecord,
  SpawnRecord,
  DispatchedActionRecord,
  SentToActiveAgentRecord,
  SentToAgentRecord,
  RunRecipeRecord,
  AgentInputRecord,
  ReadScreenRecord,
  RegisteredForgeProviderRecord,
  RegisteredFileDecorationProviderRecord,
  RegisteredSearchProviderRecord,
  RegisteredServiceRecord,
  ServiceCallRecord,
  MockServiceProvider,
  RegisteredContextProviderRecord,
  RegisteredWorktreeSetupStepRecord,
  RegisteredWorktreeDeleteNotesProviderRecord,
  RegisteredMcpToolsRecord,
  InvalidationRecord,
  SetToolbarButtonBadgeRecord,
  SetToolbarButtonStateRecord,
  SetContextRecord,
  SetWorktreeReviewChecksRecord,
  SetWorktreeCardStatusRecord,
  SetTerminalStatusRecord,
  SetPanelActivityRecord,
  SetPanelBadgeRecord,
  SetPanelMenuItemsRecord,
  ShowQuickPickRecord,
  ShowInputBoxRecord,
  ShowConfirmRecord,
  FsWriteRecord,
  MockSubscriptionRecord,
  GitCommitRecord,
  MockHostState,
  CreateMockHostOptions,
} from "./mockHost/types.js";

export function createMockHost(options: CreateMockHostOptions = {}): PluginHostApi & MockHostState {
  // Each facet owns its state and the simulate helpers that drive it; one
  // facet's read of another's state is a collaborator passed in here, so this
  // wiring is the whole of what crosses between them.
  const identity = createMockIdentity(options);
  const workspace = createWorkspaceFacet(identity, options);
  const contributions = createContributionsFacet(identity, options, {
    recordMockLaunch: workspace.recordMockLaunch,
  });
  const settings = createSettingsFacet(identity, options, {
    activeWorktreePath: workspace.activeWorktreePath,
    recordDispatch: contributions.recordDispatch,
  });
  const files = createFilesFacet(identity, options, {
    worktreeRoots: workspace.worktreeRoots,
  });
  const presentation = createPresentationFacet(identity, options, {
    resolveWorktreesResult: workspace.resolveWorktreesResult,
    agentPanes: workspace.agentPanes,
    panelPhases: workspace.panelPhases,
    // Through the composed host, so a test spying on `host.notify` sees a
    // task's failure and success notifications too.
    notify: (notifyOptions) => host.notify(notifyOptions),
  });

  const host: PluginHostApi & MockHostState = {
    pluginId: identity.pluginId,
    pluginInfo: identity.pluginInfo,
    ...contributions.members,
    ...workspace.members,
    ...presentation.members,
    ...files.members,
    ...settings.members,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  return host;
}
