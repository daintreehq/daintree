import { expect, type Page } from "@playwright/test";
import { SEL } from "./selectors";

export interface ThemeChromeMetrics {
  projectTitleContrast: number;
  quickRunFieldBorderContrast: number;
  worktreeSectionContrast: number;
  sidebarVsCanvasContrast: number;
  panelVsGridContrast: number;
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
  options: { worktreeCardSelector?: string; projectName: string }
): Promise<ThemeChromeMetrics> {
  const worktreeCardSelector = options.worktreeCardSelector ?? SEL.worktree.mainCard;
  return page.evaluate(
    (selectors) => {
      type Rgba = { r: number; g: number; b: number; a: number };

      function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
        // OKLab → linear sRGB via LMS intermediate
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.291485548 * b;
        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;
        const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        const bv = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
        // Linear sRGB → gamma-corrected sRGB
        const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
        return [
          Math.round(Math.min(1, Math.max(0, gamma(r))) * 255),
          Math.round(Math.min(1, Math.max(0, gamma(g))) * 255),
          Math.round(Math.min(1, Math.max(0, gamma(bv))) * 255),
        ];
      }

      function parseColor(input: string | null): Rgba {
        if (!input) return { r: 0, g: 0, b: 0, a: 0 };

        const normalized = input.trim().toLowerCase();
        if (normalized === "transparent") {
          return { r: 0, g: 0, b: 0, a: 0 };
        }

        const rgbMatch = normalized.match(
          /^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:(?:\s*,\s*|\s*\/\s*)([\d.]+))?\s*\)$/
        );
        if (rgbMatch) {
          return {
            r: Number(rgbMatch[1]),
            g: Number(rgbMatch[2]),
            b: Number(rgbMatch[3]),
            a: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]),
          };
        }

        // oklab(L a b) or oklab(L a b / alpha)
        const oklabMatch = normalized.match(
          /^oklab\(\s*([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+))?\s*\)$/
        );
        if (oklabMatch) {
          const [r, g, b] = oklabToSrgb(
            Number(oklabMatch[1]),
            Number(oklabMatch[2]),
            Number(oklabMatch[3])
          );
          return { r, g, b, a: oklabMatch[4] === undefined ? 1 : Number(oklabMatch[4]) };
        }

        // oklch(L C H) or oklch(L C H / alpha)
        const oklchMatch = normalized.match(
          /^oklch\(\s*([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+))?\s*\)$/
        );
        if (oklchMatch) {
          const Lv = Number(oklchMatch[1]);
          const C = Number(oklchMatch[2]);
          const H = (Number(oklchMatch[3]) * Math.PI) / 180;
          const [r, g, b] = oklabToSrgb(Lv, C * Math.cos(H), C * Math.sin(H));
          return { r, g, b, a: oklchMatch[4] === undefined ? 1 : Number(oklchMatch[4]) };
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
      const sidebar = document.querySelector<HTMLElement>(selectors.sidebar);
      const gridPanel = document.querySelector<HTMLElement>(selectors.gridPanel);
      const gridContainer = document.querySelector<HTMLElement>(selectors.gridContainer);

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

      const rootBackground = resolveEffectiveBackground(document.body);
      const sidebarBackground = sidebar ? resolveEffectiveBackground(sidebar) : rootBackground;
      const gridContainerBackground = gridContainer
        ? resolveEffectiveBackground(gridContainer)
        : rootBackground;
      const panelBackground = gridPanel ? resolveEffectiveBackground(gridPanel) : null;

      return {
        projectTitleContrast: contrastRatio(
          parseColor(getComputedStyle(projectTitle).color),
          projectBackground
        ),
        quickRunFieldBorderContrast: contrastRatio(fieldBorderColor, quickRunBackground),
        worktreeSectionContrast: contrastRatio(sectionBackground, cardBackground),
        sidebarVsCanvasContrast: contrastRatio(sidebarBackground, rootBackground),
        panelVsGridContrast: panelBackground
          ? contrastRatio(panelBackground, gridContainerBackground)
          : Infinity,
      };
    },
    {
      projectTrigger: SEL.toolbar.projectSwitcherTrigger,
      quickRunInput: '[aria-label="Command input"]',
      worktreeCard: worktreeCardSelector,
      projectName: options.projectName,
      sidebar: 'aside[aria-label="Sidebar"]',
      gridPanel: SEL.panel.gridPanel,
      gridContainer: "#terminal-grid",
    }
  );
}
