/**
 * The identity every `createMockHost` facet shares: the instance key the mock
 * was built with, what it parses to, and the capabilities it grants. Read-only;
 * each facet keeps its own state.
 */

import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../types/plugin.js";
import type { PluginIdentity } from "../../types/plugin.js";
import type { CreateMockHostOptions } from "./types.js";

export interface MockHostIdentity {
  readonly pluginId: string;
  readonly manifestId: string;
  readonly projectId: string | null;
  readonly pluginInfo: PluginIdentity;
  readonly capabilities: ReadonlySet<string>;
  readonly hasActiveAgent: boolean;
}

export function createMockIdentity(options: CreateMockHostOptions): MockHostIdentity {
  const pluginId = options.pluginId ?? "test.mock";

  // Capability gating + active-agent presence for the agent APIs (#10617).
  // Default permissive so manifest-free tests are unaffected; restrict to assert
  // the PERMISSION_REQUIRED / NO_ACTIVE_AGENT rejections production enforces.
  const capabilities = new Set<string>(options.capabilities ?? ["agent:read", "agent:input"]);
  const hasActiveAgent = options.hasActiveAgent ?? true;

  // Identity mirrors the real host: derived from the id via the canonical
  // parser, so a mock built with a project instance key answers exactly as
  // production does.
  const mockManifestId = pluginManifestIdFromInstanceKey(pluginId);
  const mockProjectId = projectIdFromPluginInstanceKey(pluginId);
  // `projectRoot` is null iff `projectId` is — a mock that claimed a project
  // with no root would hand plugin authors a shape production never produces.
  const mockProjectRoot =
    mockProjectId === null ? null : (options.projectRoot ?? `/projects/${mockProjectId}`);
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId: mockManifestId,
    origin: mockProjectId === null ? ("global" as const) : ("project" as const),
    projectId: mockProjectId,
    projectRoot: mockProjectRoot,
  });
  return Object.freeze({
    pluginId,
    manifestId: mockManifestId,
    projectId: mockProjectId,
    pluginInfo,
    capabilities,
    hasActiveAgent,
  });
}
