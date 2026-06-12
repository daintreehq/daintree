import type { Page } from "@playwright/test";
import type { ProjectSettings } from "../../shared/types";

export async function saveCurrentProjectSettings(
  page: Page,
  settings: Partial<ProjectSettings>
): Promise<void> {
  await page.evaluate(async (partialSettings) => {
    const current = await window.electron.project.getCurrent();
    if (!current?.id) return;

    const dispatch = window.__daintreeDispatchAction;
    if (typeof dispatch !== "function") {
      throw new Error("Action dispatch hook not available");
    }

    await dispatch(
      "project.saveSettings",
      { projectId: current.id, settings: partialSettings },
      { source: "test" }
    );
  }, settings);
}
