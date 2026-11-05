import { expect, type Locator, type Page } from "@playwright/test";

/** Finish the wizard for a fixture Host listening only for this test run. */
export async function connectListeningFixtureHost(
  page: Page,
  dialog: Locator,
  name: string
): Promise<string> {
  await dialog.getByRole("button", { name: "Set up Host mode…", exact: true }).click();
  await dialog.getByRole("button", { name: "Skip Host mode", exact: true }).click();
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: /^(Done|Close)$/ }).click();
  }
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const hosts = await page.evaluate(() => window.electron.remoteHosts.list());
  const host = hosts.find((entry) => entry.descriptor.name === name);
  expect(host, JSON.stringify(hosts)).toBeTruthy();
  const hostId = host!.descriptor.id;
  await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), hostId);
  await expect
    .poll(
      async () => {
        const entries = await page.evaluate(() => window.electron.remoteHosts.list());
        return entries.find((entry) => entry.descriptor.id === hostId)?.connection.status;
      },
      { timeout: 60_000 }
    )
    .toBe("connected");
  return hostId;
}
