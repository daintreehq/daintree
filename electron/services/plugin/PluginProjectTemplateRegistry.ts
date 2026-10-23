import type {
  ProjectTemplateContribution,
  ProjectTemplateDescriptor,
} from "../../../shared/types/plugin.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";

/**
 * Main-process registry for plugin project templates (#13825).
 *
 * Holds what the Create project dialog lists, plus the one thing renderers
 * never see: the plugin folder the template's files are read from. A renderer
 * names a template by plugin and template id only, and main resolves the
 * folder here, so no path supplied over IPC is ever read.
 *
 * Replaced wholesale per plugin on load and dropped on unload, like
 * `PluginTourRegistry`. Nothing subscribes: the dialog asks when it opens.
 */

interface RegisteredPluginTemplates {
  pluginDir: string;
  descriptors: ProjectTemplateDescriptor[];
}

const templatesByPlugin = new Map<string, RegisteredPluginTemplates>();

/**
 * Register a plugin's templates, replacing any it registered before. The
 * author's text is made display-safe here, once, so a bidi override in a title
 * can't reorder the dialog's own copy around it.
 */
export function registerPluginProjectTemplates(
  pluginId: string,
  pluginName: string,
  pluginDir: string,
  templates: readonly ProjectTemplateContribution[]
): void {
  if (templates.length === 0) {
    templatesByPlugin.delete(pluginId);
    return;
  }
  templatesByPlugin.set(pluginId, {
    pluginDir,
    descriptors: templates.map((template) => ({
      pluginId,
      pluginName: displaySafeText(pluginName),
      templateId: template.id,
      title: displaySafeText(template.title),
      description: displaySafeText(template.description),
      ...(template.iconId !== undefined ? { iconId: template.iconId } : {}),
    })),
  });
}

/** Drop every template registered by `pluginId`. Safe for an unknown id. */
export function unregisterPluginProjectTemplates(pluginId: string): void {
  templatesByPlugin.delete(pluginId);
}

/** Reset the registry (test isolation / full plugin-system teardown). */
export function clearPluginProjectTemplateRegistry(): void {
  templatesByPlugin.clear();
}

/**
 * Every registered template, ordered by plugin name and then title so the
 * dialog's list doesn't depend on load order. Fresh copies: the array crosses
 * IPC.
 */
export function getPluginProjectTemplates(): ProjectTemplateDescriptor[] {
  return [...templatesByPlugin.values()]
    .flatMap(({ descriptors }) => descriptors.map((descriptor) => ({ ...descriptor })))
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.title.localeCompare(b.title));
}

/** The folder of the plugin that registered `templateId`, or undefined if none did. */
export function getPluginProjectTemplatePluginDir(
  pluginId: string,
  templateId: string
): string | undefined {
  const registered = templatesByPlugin.get(pluginId);
  if (!registered) return undefined;
  return registered.descriptors.some((descriptor) => descriptor.templateId === templateId)
    ? registered.pluginDir
    : undefined;
}
