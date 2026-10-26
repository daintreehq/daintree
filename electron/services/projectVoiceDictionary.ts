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
 * When a project starts keeping its settings in the repo: a vocabulary
 * already committed there is the team's and is adopted as it is; otherwise
 * the local one is committed, so turning sharing on doesn't lose it.
 */
export async function shareLocalVoiceDictionary(projectId: string): Promise<void> {
  const project = requireProject(projectId);
  if ((await projectStore.readInRepoVoiceDictionary(project.path)).found) return;
  const local = (await projectStore.getProjectSettings(projectId)).voiceDictionary ?? [];
  if (local.length === 0) return;
  await projectStore.changeInRepoVoiceDictionary(project.path, () => local);
}

/**
 * Before a project stops keeping its settings in the repo, carry the list in
 * use (the committed one, empty when the repo has none) into its local
 * settings, so turning sharing off doesn't bring back an older local list.
 */
export async function keepSharedVoiceDictionaryLocally(projectId: string): Promise<void> {
  const project = requireProject(projectId);
  if (!project.inRepoSettings) return;
  let entries: VoiceDictionaryEntry[];
  try {
    ({ entries } = await projectStore.readInRepoVoiceDictionary(project.path));
  } catch (error) {
    // A committed file that can't be read leaves the local list as it was, and
    // turning sharing off still goes ahead. A failed local write does not.
    console.warn("[ProjectVoiceDictionary] Couldn't read the committed vocabulary:", error);
    return;
  }
  await projectStore.changeLocalVoiceDictionary(projectId, () => entries);
}
