// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";

const announce = vi.fn();

vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce }) },
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    importTheme: vi.fn(),
    exportTheme: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/appThemeViewTransition", () => ({
  runThemeReveal: (_origin: unknown, cb: () => void) => cb(),
}));

const storeState: Record<string, unknown> = {};

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState }
  ),
  injectSchemeToDOM: vi.fn(),
}));

vi.mock("@shared/theme", () => ({
  APP_THEME_PREVIEW_KEYS: { background: "--daintree-bg" },
  getAppThemeWarnings: () => [],
  applyAccentOverrideToScheme: (scheme: unknown) => scheme,
  accentOverrideHasLowContrast: () => false,
  resolveAppTheme: (id: string, customSchemes: { id: string }[]) =>
    customSchemes.find((s) => s.id === id) ?? {
      id,
      name: id,
      type: "dark",
      tokens: { "--daintree-bg": "#000" },
    },
}));

vi.mock("@/config/appColorSchemes", () => ({
  BUILT_IN_APP_SCHEMES: [
    {
      id: "theme-a",
      name: "Theme A",
      type: "dark" as const,
      tokens: { "--daintree-bg": "#000" },
    },
  ],
}));

import { appThemeClient } from "@/clients/appThemeClient";
import { AppThemePicker } from "../AppThemePicker";

// Minimal fixture — the picker only reads name/id off the imported scheme, so we
// cast past the full token map rather than enumerate every required token key.
const importedScheme = {
  id: "imported-theme",
  name: "Imported Theme",
  type: "dark",
  builtin: false,
  tokens: { "surface-canvas": "#000" },
} as unknown as AppColorScheme;

function importResultWith(warnings: AppThemeValidationWarning[]) {
  return { ok: true as const, scheme: importedScheme, warnings };
}

function clickImport() {
  fireEvent.click(screen.getByText("Import app theme..."));
}

beforeEach(() => {
  announce.mockClear();
  vi.mocked(appThemeClient.importTheme).mockReset();
  Object.assign(storeState, {
    selectedSchemeId: "theme-a",
    customSchemes: [],
    recentSchemeIds: [],
    followSystem: false,
    preferredDarkSchemeId: "theme-a",
    preferredLightSchemeId: "theme-a",
    commitSchemeSelection: vi.fn(),
    setFollowSystem: vi.fn(),
    setPreferredDarkSchemeId: vi.fn(),
    setPreferredLightSchemeId: vi.fn(),
    setRecentSchemeIds: vi.fn(),
    addCustomScheme: vi.fn(),
    accentColorOverride: null,
    setAccentColorOverride: vi.fn(),
  });
});

describe("AppThemePicker import feedback — plain-language warnings", () => {
  it("renders one friendly line per warning kind instead of the raw diagnostics", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue(
      importResultWith([
        {
          kind: "low-contrast",
          message: "text-primary on surface-canvas is 3.91:1; target is 4.5:1",
        },
        {
          kind: "low-contrast",
          message:
            "accent-primary outline on surface-panel is 2.34:1; target is 3.0:1 (WCAG 1.4.11 Non-text Contrast)",
        },
        {
          kind: "type-inferred",
          message: 'Theme type was inferred as dark. Add "type" to make the file explicit.',
        },
      ])
    );

    render(<AppThemePicker />);
    clickImport();

    // Two low-contrast warnings collapse to a single friendly row.
    const lowContrastRows = await screen.findAllByText("Some colors may be hard to see");
    expect(lowContrastRows).toHaveLength(1);
    expect(screen.getByText("Theme mode was guessed from the colors")).toBeTruthy();
  });

  it("keeps raw engine diagnostics out of the primary copy and inside a details disclosure", async () => {
    const rawMessage = "text-primary on surface-canvas is 3.91:1; target is 4.5:1";
    vi.mocked(appThemeClient.importTheme).mockResolvedValue(
      importResultWith([{ kind: "low-contrast", message: rawMessage }])
    );

    const { container } = render(<AppThemePicker />);
    clickImport();

    const rawNode = await screen.findByText(rawMessage);
    // The raw diagnostic must live behind a <details> disclosure, never as
    // top-level summary text.
    expect(rawNode.closest("details")).not.toBeNull();

    // One disclosure per kind, each labelled for theme authors.
    const disclosures = container.querySelectorAll("details");
    expect(disclosures).toHaveLength(1);
    expect(screen.getByText("Technical details")).toBeTruthy();

    // The headline summary names the count, not WCAG jargon.
    expect(screen.getByText('Imported "Imported Theme" with 1 warning.')).toBeTruthy();
  });

  it("renders the result block as an aria status live region", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue(importResultWith([]));

    const { container } = render(<AppThemePicker />);
    clickImport();

    await screen.findByText('Imported "Imported Theme".');
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('Imported "Imported Theme".');
  });
});

describe("AppThemePicker import feedback — screen-reader announcement", () => {
  it("announces the summary when an import succeeds with warnings", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue(
      importResultWith([{ kind: "unknown-tokens", message: "Ignored unknown tokens: foo, bar" }])
    );

    render(<AppThemePicker />);
    clickImport();

    await screen.findByText("Some values in this theme weren't recognized");
    expect(announce).toHaveBeenCalledWith('Imported "Imported Theme" with 1 warning.');
  });

  it("announces the summary when an import succeeds cleanly", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue(importResultWith([]));

    render(<AppThemePicker />);
    clickImport();

    await screen.findByText('Imported "Imported Theme".');
    expect(announce).toHaveBeenCalledWith('Imported "Imported Theme".');
  });

  it("announces the error when an import fails", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue({
      ok: false,
      errors: ["Theme file is not valid JSON"],
    });

    render(<AppThemePicker />);
    clickImport();

    await screen.findByText("Theme file is not valid JSON");
    expect(announce).toHaveBeenCalledWith("Theme file is not valid JSON");
  });

  it("stays silent when the user cancels the import", async () => {
    vi.mocked(appThemeClient.importTheme).mockResolvedValue({
      ok: false,
      errors: ["Import cancelled"],
    });

    render(<AppThemePicker />);
    clickImport();

    // Let the async handler settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(announce).not.toHaveBeenCalled();
    expect(screen.queryByText("Import cancelled")).toBeNull();
  });
});
