import type { VoiceDictionaryEntry } from "../../shared/types/ipc/api.js";
import { projectStore } from "./ProjectStore.js";

// A project's dictation vocabulary has one home at a time, never a merge of
// two: a project that keeps its settings in the repo reads and writes
// `.daintree/settings.json`, so a teammate's committed terms arrive with a
// pull; any other project uses its local settings.

type Apply = (entries: VoiceDictionaryEntry[]) => VoiceDictionaryEntry[];

function requireProject(projectId: string) {
  const project = projectStore.getProjectById(projectId);
  if (!project) throw new Error("Project not found");
  return project;
}

export async function readProjectVoiceDictionary(
  projectId: string
): Promise<VoiceDictionaryEntry[]> {
  const project = requireProject(projectId);
  if (project.inRepoSettings) {
    return (await projectStore.readInRepoVoiceDictionary(project.path)).entries;
  }
  return (await projectStore.getProjectSettings(projectId)).voiceDictionary ?? [];
}

export async function changeProjectVoiceDictionary(
  projectId: string,
  apply: Apply
): Promise<VoiceDictionaryEntry[]> {
  const project = requireProject(projectId);
  if (project.inRepoSettings) {
    return projectStore.changeInRepoVoiceDictionary(project.path, apply);
  }
  return projectStore.changeLocalVoiceDictionary(projectId, apply);
}

/**
 * Before a project stops keeping its settings in the repo, carry the
 * committed vocabulary into its local settings, so turning sharing off
 * doesn't bring back an older local list.
 */
export async function keepSharedVoiceDictionaryLocally(projectId: string): Promise<void> {
  const project = requireProject(projectId);
  if (!project.inRepoSettings) return;
  const shared = await projectStore.readInRepoVoiceDictionary(project.path);
  if (!shared.found) return;
  await projectStore.changeLocalVoiceDictionary(projectId, () => shared.entries);
}
