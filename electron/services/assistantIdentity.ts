// eager-import-allow: reads and writes the assistant personas via store.get synchronously so a merge and its write share one turn
import { store } from "../store.js";
import type {
  AssistantIdentities,
  AssistantIdentityScope,
  DisplayIdentity,
} from "../../shared/types/displayIdentity.js";
import {
  assistantIdentityFor,
  isEmptyDisplayIdentity,
  normalizeDisplayEmoji,
  normalizeDisplayIdentity,
  normalizeDisplayName,
} from "../../shared/utils/displayIdentity.js";
import { AppError } from "../utils/errorTypes.js";

/** Most projects with a persona kept; setting one past it forgets the oldest. */
export const PROJECT_IDENTITIES_MAX = 500;
const PROJECT_ID_MAX = 256;

export const EMOJI_REFUSED_MESSAGE = "Choose a single emoji.";

/** Personas as stored, made safe: an invalid field is unset, an empty persona is no entry. */
export function sanitizeStoredIdentities(stored: unknown): AssistantIdentities {
  const record =
    stored && typeof stored === "object" ? (stored as Record<string, unknown>) : undefined;
  const projects: [string, DisplayIdentity][] = [];
  const rawProjects = record?.projects;
  if (rawProjects && typeof rawProjects === "object" && !Array.isArray(rawProjects)) {
    for (const [projectId, value] of Object.entries(rawProjects)) {
      if (!projectId || projectId.length > PROJECT_ID_MAX) continue;
      const identity = normalizeDisplayIdentity(value);
      if (!isEmptyDisplayIdentity(identity)) projects.push([projectId, identity]);
    }
  }
  return {
    global: normalizeDisplayIdentity(record?.global),
    // fromEntries defines own properties, so no project id can reach a prototype.
    projects: Object.fromEntries(projects.slice(-PROJECT_IDENTITIES_MAX)),
  };
}

export function readAssistantIdentities(): AssistantIdentities {
  return sanitizeStoredIdentities(store.get("helpAssistant")?.identities);
}

/** The persona one assistant scope wears; empty when it has none. */
export function readAssistantIdentity(scope: AssistantIdentityScope): DisplayIdentity {
  return assistantIdentityFor(readAssistantIdentities(), scope);
}

function refuse(message: string): never {
  throw new AppError({ code: "VALIDATION", message, userMessage: message });
}

function parseScope(value: unknown): AssistantIdentityScope {
  if (!value || typeof value !== "object") refuse("An assistant scope is required.");
  const scope = value as Record<string, unknown>;
  if (scope.kind === "global") return { kind: "global" };
  if (
    scope.kind === "project" &&
    typeof scope.projectId === "string" &&
    scope.projectId.length > 0 &&
    scope.projectId.length <= PROJECT_ID_MAX
  ) {
    return { kind: "project", projectId: scope.projectId };
  }
  return refuse("An assistant scope is required.");
}

function parseIdentity(value: unknown): DisplayIdentity {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  if (record.name !== undefined && typeof record.name !== "string") {
    refuse("A name must be text.");
  }
  const name = normalizeDisplayName(record.name);
  let emoji: string | undefined;
  if (typeof record.emoji === "string" && record.emoji.trim() !== "") {
    emoji = normalizeDisplayEmoji(record.emoji);
    if (emoji === undefined) refuse(EMOJI_REFUSED_MESSAGE);
  } else if (record.emoji !== undefined && typeof record.emoji !== "string") {
    refuse(EMOJI_REFUSED_MESSAGE);
  }
  return { ...(name !== undefined && { name }), ...(emoji !== undefined && { emoji }) };
}

/**
 * Replace one scope's persona and return every persona as now stored. The
 * request is checked whole before anything is written, and the stored map is
 * merged per project, so a view that read it earlier can't erase another
 * project's persona.
 */
export function writeAssistantIdentity(request: unknown): AssistantIdentities {
  if (!request || typeof request !== "object") refuse("An assistant scope is required.");
  const { scope: rawScope, identity: rawIdentity } = request as Record<string, unknown>;
  const scope = parseScope(rawScope);
  const identity = parseIdentity(rawIdentity);
  const current = readAssistantIdentities();
  let next: AssistantIdentities;
  if (scope.kind === "global") {
    next = { ...current, global: identity };
  } else {
    const projects = Object.entries(current.projects).filter(([id]) => id !== scope.projectId);
    if (!isEmptyDisplayIdentity(identity)) projects.push([scope.projectId, identity]);
    next = {
      ...current,
      projects: Object.fromEntries(projects.slice(-PROJECT_IDENTITIES_MAX)),
    };
  }
  store.set("helpAssistant.identities", next);
  return next;
}
