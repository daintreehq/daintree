import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { ActionDispatchResult } from "../../shared/types/actions";

/**
 * Project-local plugins take the path a real third-party plugin takes: they are
 * discovered under `<repo>/.daintree/plugins/<name>/`, stay dark until the
 * project's plugins are trusted, load with `isBuiltin: false`, and activate in
 * a forked worker that talks to the host over IPC. The sample sideload
 * (`DAINTREE_E2E_SIDELOAD_PLUGIN_DIR`) loads in-process as a builtin instead,
 * so it never exercises that path.
 */

export interface ProjectPluginSource {
  /** `plugin.json` minus `name`, which is always the directory name. */
  manifest: Record<string, unknown>;
  /** Plugin-relative path → file contents (e.g. `dist/index.mjs`, `dist/panel.js`). */
  files: Record<string, string>;
}

/**
 * Write a zero-build plugin into the fixture repo where a project plugin lives.
 * The manifest id must not use the reserved `daintree.*` namespace, which only
 * builtins may claim. Returns the plugin's directory.
 */
export function installProjectPlugin(
  repoDir: string,
  name: string,
  source: ProjectPluginSource
): string {
  if (name.startsWith("daintree.")) {
    throw new Error(`"${name}": daintree.* ids are reserved for builtins`);
  }
  const root = path.join(repoDir, ".daintree", "plugins", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
  writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify({ name, ...source.manifest }, null, 2) + "\n"
  );
  for (const [rel, contents] of Object.entries(source.files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

/** Trust the active project's plugins, the consent a user gives in the trust prompt. */
export async function trustProjectPlugins(page: Page): Promise<void> {
  await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
}

export interface ProjectPluginPanelKind {
  /** Project-qualified panel kind id, for `panel.openPluginPanel`. */
  kindId: string;
  /** Plugin instance id, as `window.electron.plugin.invoke` and the perf snapshots key it. */
  pluginId: string;
}

/**
 * Wait for a project plugin's panel kind to register. Kind and instance ids
 * are namespaced by the project, so match on the manifest-id suffix.
 */
export async function waitForProjectPluginPanelKind(
  page: Page,
  name: string,
  panel = "main",
  timeout = 60_000
): Promise<ProjectPluginPanelKind> {
  let found: ProjectPluginPanelKind | undefined;
  await expect
    .poll(
      async () => {
        const kinds = await page.evaluate(() => window.electron.plugin.getPanelKinds());
        const kind = kinds.find(
          (k) => k.extensionId?.endsWith(name) && k.id.endsWith(`${name}/${panel}`)
        );
        found = kind ? { kindId: kind.id, pluginId: kind.extensionId! } : undefined;
        return found !== undefined;
      },
      { timeout, message: `panel kind ${name}/${panel} never registered` }
    )
    .toBe(true);
  return found!;
}

/** Open a plugin panel through the same action the panel palette dispatches. Returns its panel id. */
export async function openProjectPluginPanel(
  page: Page,
  kindId: string,
  options: { reuseExisting?: boolean } = {}
): Promise<string> {
  const result = await page.evaluate(
    ({ kind, reuseExisting }) => {
      const bridge = window as unknown as {
        __daintreeDispatchAction: (
          id: string,
          args: unknown,
          options: { source: string }
        ) => Promise<ActionDispatchResult<{ panelId: string }>>;
      };
      return bridge.__daintreeDispatchAction(
        "panel.openPluginPanel",
        { kind, reuseExisting },
        { source: "user" }
      );
    },
    { kind: kindId, reuseExisting: options.reuseExisting }
  );
  if (!result.ok) {
    throw new Error(`panel.openPluginPanel failed: ${JSON.stringify(result)}`);
  }
  return result.result.panelId;
}
