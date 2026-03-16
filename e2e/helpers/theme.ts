import { expect, type Page } from "@playwright/test";
import { SEL } from "./selectors";

export interface ThemeChromeMetrics {
  projectTitleContrast: number;
  quickRunFieldBorderContrast: number;
  worktreeSectionContrast: number;
}

export async function setAppTheme(page: Page, schemeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, schemeId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.openSettings).waitFor({ state: "visible", timeout: 10_000 });
  await page
    .locator(SEL.toolbar.projectSwitcherTrigger)
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.getByLabel("Command input").waitFor({ state: "visible", timeout: 10_000 });

  await expect
    .poll(
      () =>
        page.locator("html").evaluate((element) => ({
          theme: element.getAttribute("data-theme"),
          colorMode: element.getAttribute("data-color-mode"),
        })),
      {
        timeout: 10_000,
        message: `Theme ${schemeId} should be applied to the document root`,
      }
    )
    .toMatchObject({ theme: schemeId, colorMode: "light" });
}

export async function getThemeChromeMetrics(
  page: Page,
  options: { branch?: string; projectName: string }
): Promise<ThemeChromeMetrics> {
  const branch = options.branch ?? "main";
  return page.evaluate(
    (selectors) => {
      type Rgba = { r: number; g: number; b: number; a: number };

      function parseColor(input: string | null): Rgba {
        if (!input) return { r: 0, g: 0, b: 0, a: 0 };

        const normalized = input.trim().toLowerCase();
        if (normalized === "transparent") {
          return { r: 0, g: 0, b: 0, a: 0 };
        }

        const rgbMatch = normalized.match(
          /^rgba?\(\s*([\d.]+)(?:\s*,|\s+)\s*([\d.]+)(?:\s*,|\s+)\s*([\d.]+)(?:(?:\s*,|\s*\/\s*)([\d.]+))?\s*\)$/
        );
        if (rgbMatch) {
          return {
            r: Number(rgbMatch[1]),
            g: Number(rgbMatch[2]),
            b: Number(rgbMatch[3]),
            a: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]),
          };
        }

        const hexMatch = normalized.match(/^#([\da-f]{3,8})$/i);
        if (hexMatch) {
          const hex = hexMatch[1];
          const expanded =
            hex.length === 3 || hex.length === 4
              ? hex
                  .split("")
                  .map((ch) => `${ch}${ch}`)
                  .join("")
              : hex;
          const hasAlpha = expanded.length === 8;
          return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
            a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
          };
        }

        return { r: 0, g: 0, b: 0, a: 1 };
      }

      function composite(foreground: Rgba, background: Rgba): Rgba {
        const alpha = foreground.a + background.a * (1 - foreground.a);
        if (alpha <= 0) {
          return { r: 0, g: 0, b: 0, a: 0 };
        }

        return {
          r:
            (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) /
            alpha,
          g:
            (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) /
            alpha,
          b:
            (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) /
            alpha,
          a: alpha,
        };
      }

      function resolveEffectiveBackground(element: Element | null): Rgba {
        let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
        let current: Element | null = element;

        while (current) {
          const background = parseColor(getComputedStyle(current).backgroundColor);
          result = composite(background, result);
          if (result.a >= 0.999) {
            return result;
          }
          current = current.parentElement;
        }

        return result;
      }

      function relativeLuminance(color: Rgba): number {
        const toLinear = (channel: number) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };

        return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
      }

      function contrastRatio(foreground: Rgba, background: Rgba): number {
        const fg = composite(foreground, background);
        const bg = background;
        const l1 = relativeLuminance(fg);
        const l2 = relativeLuminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }

      const projectTrigger = document.querySelector<HTMLElement>(selectors.projectTrigger);
      const quickRunInput = document.querySelector<HTMLInputElement>(selectors.quickRunInput);
      const worktreeCard = document.querySelector<HTMLElement>(selectors.worktreeCard);

      if (!projectTrigger || !quickRunInput || !worktreeCard) {
        throw new Error("Required theme smoke selectors were not found");
      }

      const projectTitle =
        projectTrigger.querySelector<HTMLElement>('[aria-label="Project emoji"] + span') ??
        Array.from(projectTrigger.querySelectorAll<HTMLElement>("span")).find(
          (element) => (element.textContent ?? "").trim() === selectors.projectName
        ) ??
        projectTrigger;

      const projectBackground = resolveEffectiveBackground(projectTrigger);
      const quickRunBackground = resolveEffectiveBackground(quickRunInput);
      const fieldBorderColor = parseColor(
        getComputedStyle(quickRunInput.parentElement!).borderColor
      );

      const detailsSection = worktreeCard.querySelector<HTMLElement>('[id$="-details"]');
      if (!detailsSection) {
        throw new Error("Worktree details section was not found");
      }

      const cardBackground = resolveEffectiveBackground(worktreeCard);
      const sectionBackground = resolveEffectiveBackground(detailsSection);

      return {
        projectTitleContrast: contrastRatio(
          parseColor(getComputedStyle(projectTitle).color),
          projectBackground
        ),
        quickRunFieldBorderContrast: contrastRatio(fieldBorderColor, quickRunBackground),
        worktreeSectionContrast: contrastRatio(sectionBackground, cardBackground),
      };
    },
    {
      projectTrigger: SEL.toolbar.projectSwitcherTrigger,
      quickRunInput: '[aria-label="Command input"]',
      worktreeCard: SEL.worktree.card(branch),
      projectName: options.projectName,
    }
  );
}
