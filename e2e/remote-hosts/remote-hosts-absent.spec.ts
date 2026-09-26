import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

/**
 * Someone who never adds a host sees today's app: no host chip, no link
 * banner and none of the host-gated actions. Settings → Hosts is the one
 * deliberate exception, as the way in to adding the first host.
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";

/** The actions that stay hidden until a host other than this machine exists. */
const HIDDEN_UNTIL_A_HOST = [
  "Switch host…",
  "Hosts overview…",
  "Open project on host…",
  "Forward port…",
];

let ctx: AppContext;
let cleanupFixture: (() => void) | undefined;

test.describe.serial("Remote hosts: absent until a host is added", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "rh-absent" });
    cleanupFixture = fixture.cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupFixture?.();
  });

  test("no host chip and no remote banner", async () => {
    const { window } = ctx;
    // The toolbar has rendered; the chip would sit beside the project switcher.
    await expect(window.locator('[data-testid="project-switcher-trigger"]')).toBeVisible();
    await expect(window.locator(SEL.remoteHosts.hostChip)).toHaveCount(0);
    await expect(window.locator(SEL.remoteHosts.connectionBanner)).toHaveCount(0);
    const hostId = await window.evaluate(
      () =>
        (window as unknown as { __DAINTREE_HOST_ID__?: { id?: string } }).__DAINTREE_HOST_ID__
          ?.id ?? null
    );
    expect(hostId).toBeNull();
  });

  test("the action palette lists none of the host-gated actions", async () => {
    const { window } = ctx;
    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible();
    const input = window.locator(SEL.actionPalette.searchInput);
    const options = window.locator(SEL.actionPalette.options);

    // A control query first, so an empty list below means filtered, not broken.
    await input.fill("toggle sidebar");
    await expect(options.first()).toBeVisible();

    for (const query of ["host", "forward port"]) {
      await input.fill(query);
      await expect
        .poll(async () => (await options.allInnerTexts()).join("\n"), { timeout: 5_000 })
        .not.toContain("Toggle Sidebar");
      const texts = (await options.allInnerTexts()).join("\n");
      for (const title of HIDDEN_UNTIL_A_HOST) expect(texts, query).not.toContain(title);
    }
    // "Add host…" is deliberately listed: like Settings → Hosts, it is the way
    // in to adding the first host (pinned by hostActions.test.ts).
    await input.fill("add host");
    await expect(options.filter({ hasText: "Add host…" })).toHaveCount(1);

    // Escape clears a query before it closes the palette.
    await input.fill("");
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Settings shows the Hosts tab, with no host in it", async () => {
    const { window } = ctx;
    await openSettings(window);
    const tab = window.locator(SEL.remoteHosts.settingsTab);
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(
      window.getByText("Add a Mac or Linux machine to run projects and agents on it from here")
    ).toBeVisible();
    await expect(window.getByRole("button", { name: "Add host", exact: true })).toBeVisible();
    await window.locator(SEL.settings.closeButton).first().click();
    await expect(window.locator(SEL.remoteHosts.hostChip)).toHaveCount(0);
  });
});
