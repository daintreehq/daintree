import { useEffect, useMemo } from "react";
import { usePluginRuntimeStore, type PluginPromptTemplate } from "@/store/pluginRuntimeStore";

/**
 * The prompt templates on offer in a project: those of installed and builtin
 * plugins, plus those of a project plugin owned by this project. A project
 * plugin's templates never show in another project's view.
 */
export function selectPromptTemplatesForProject(
  all: readonly PluginPromptTemplate[],
  projectId: string | undefined
): PluginPromptTemplate[] {
  return all.filter((entry) => entry.projectId === null || entry.projectId === projectId);
}

export function usePluginPromptTemplates(projectId: string | undefined): PluginPromptTemplate[] {
  const all = usePluginRuntimeStore((s) => s.promptTemplates);
  useEffect(() => {
    usePluginRuntimeStore.getState().init();
  }, []);
  return useMemo(() => selectPromptTemplatesForProject(all, projectId), [all, projectId]);
}
