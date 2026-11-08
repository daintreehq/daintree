import { useEffect, useMemo } from "react";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";
import { useUserPromptTemplateStore } from "@/store/userPromptTemplateStore";
import type { PromptTemplateContribution } from "@shared/types/plugin";
import { usePluginPromptTemplates } from "./usePluginPromptTemplates";

/** A template on offer in the `/` menu, whoever it belongs to. */
export interface PromptTemplateEntry {
  /** Unique across sources. A plugin's holds `::`; a person's starts `user:`. */
  key: string;
  /** Who the row's badge names. */
  sourceName: string;
  /** The line under the title of the template's form. */
  attribution: string;
  template: PromptTemplateContribution;
}

/** The person's templates ahead of the plugins', which keep the order they had. */
export function mergePromptTemplates(
  userTemplates: readonly PromptTemplateContribution[],
  pluginTemplates: readonly PluginPromptTemplate[]
): PromptTemplateEntry[] {
  return [
    ...userTemplates.map((template) => ({
      key: `user:${template.id}`,
      sourceName: "You",
      attribution: "Your template",
      template,
    })),
    ...pluginTemplates.map((entry) => ({
      key: entry.key,
      sourceName: entry.pluginName,
      attribution: `From ${entry.pluginName}`,
      template: entry.template,
    })),
  ];
}

/**
 * Every template a project's composers offer. A person's are the same in every
 * project, and in a remote window are this machine's, beside the host's plugins'.
 */
export function usePromptTemplates(projectId: string | undefined): PromptTemplateEntry[] {
  const pluginTemplates = usePluginPromptTemplates(projectId);
  const userTemplates = useUserPromptTemplateStore((s) => s.templates);
  // Before the first `/`, not at it: with no row to pick yet, Enter on a token
  // sends it to the agent as typed.
  useEffect(() => {
    useUserPromptTemplateStore.getState().init();
  }, []);
  return useMemo(
    () => mergePromptTemplates(userTemplates, pluginTemplates),
    [userTemplates, pluginTemplates]
  );
}
