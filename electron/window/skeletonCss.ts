// eager-import-allow: reads theme tokens via store.get synchronously to inline first-paint skeleton CSS
/**
 * Injects CSS custom properties into a WebContents so the HTML skeleton
 * in index.html renders with the correct theme and layout dimensions
 * before React mounts.
 *
 * Called from both createWindow (initial load) and ProjectViewManager
 * (project switch cold starts).
 */
import { nativeTheme, type WebContents } from "electron";
import { store } from "../store.js";
import {
  resolveAppTheme,
  getAppThemeCssVariables,
  applyAccentOverrideToScheme,
} from "../../shared/theme/index.js";
import type { AppColorScheme, AppThemeConfig } from "../../shared/theme/index.js";
import type { Project } from "../../shared/types/project.js";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../schemas/customSchemes.js";

/**
 * Command-line argument carrying the persisted color scheme id from the main
 * process into each renderer context. Read synchronously in preload.cts from
 * `process.argv` (available even under `sandbox: true`) and exposed to the
 * renderer as `window.__DAINTREE_INITIAL_THEME__` so first paint applies the
 * saved theme instead of a `prefers-color-scheme` default (#9169).
 */
export const INITIAL_COLOR_SCHEME_ARG = "--daintree-initial-color-scheme-id";

/**
 * Command-line argument carrying the destination project id from the main
 * process into each project-switch `WebContentsView`. Replaces the former
 * `?projectId=` query string on `loadURL` so the document URL stays static
 * across projects, keeping the V8 bytecode cache (`v8CacheOptions`)
 * keyed to a single URL instead of fragmenting one entry per project (#9162).
 * Read synchronously in preload.cts from `process.argv` and exposed as
 * `window.__DAINTREE_INITIAL_PROJECT__`.
 */
export const INITIAL_PROJECT_ID_ARG = "--daintree-initial-project-id";

/**
 * Command-line argument carrying the instance role (`worker` | `attended`)
 * from the main process into each renderer context (#10123). Worker instances
 * (`DAINTREE_INSTANCE_ROLE=worker`) suppress automatic background GitHub
 * polling to conserve GraphQL quota; on-demand fetches stay functional.
 * Read synchronously in preload.cts from `process.argv` and exposed as
 * `window.__DAINTREE_INSTANCE_ROLE__`. Default is `attended` — no behavior
 * change unless an instance explicitly opts in.
 */
export const INSTANCE_ROLE_ARG = "--daintree-instance-role";

/**
 * E2E-only preload flags. These mirror the first-paint/project identity args:
 * the main process reads the launch environment, then threads stable argv
 * flags into each sandboxed renderer preload. Relying on preload `process.env`
 * alone is brittle under sandboxed Electron contexts.
 */
export const E2E_MODE_ARG = "--daintree-e2e-mode";
export const E2E_SKIP_FIRST_RUN_DIALOGS_ARG = "--daintree-e2e-skip-first-run-dialogs";
export const E2E_FAULT_MODE_ARG = "--daintree-e2e-fault-mode";

export type InstanceRole = "attended" | "worker";

/**
 * Resolves the instance role from the launch environment. Only the exact
 * value `worker` opts in; anything else (unset, empty, malformed) falls back
 * to `attended` so a typo can never silently disable polling for an attended
 * instance — or, worse, leave a worker polling.
 */
export function resolveInstanceRole(): InstanceRole {
  return process.env.DAINTREE_INSTANCE_ROLE === "worker" ? "worker" : "attended";
}

export function resolveE2EPreloadArgs(): string[] {
  const args: string[] = [];
  if (process.env.DAINTREE_E2E_MODE === "1" || process.argv.includes(E2E_MODE_ARG)) {
    args.push(E2E_MODE_ARG);
  }
  if (
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS === "1" ||
    process.argv.includes(E2E_SKIP_FIRST_RUN_DIALOGS_ARG)
  ) {
    args.push(E2E_SKIP_FIRST_RUN_DIALOGS_ARG);
  }
  if (process.env.DAINTREE_E2E_FAULT_MODE === "1" || process.argv.includes(E2E_FAULT_MODE_ARG)) {
    args.push(E2E_FAULT_MODE_ARG);
  }
  return args;
}

/**
 * Resolves the color scheme id to seed the renderer with on cold start.
 * Mirrors the fallback logic in createWindow and getAppThemeConfig: the raw
 * persisted id when present (without resolving `followSystem` — that happens
 * post-mount), else Daintree's dark default, or Bondi when the OS prefers a
 * light appearance. Accepts a pre-read theme config so callers that already
 * hold one avoid a redundant full-store read (every `store.get()` re-reads
 * the config file from disk).
 */
export function resolveInitialColorSchemeId(
  themeConfig: Partial<AppThemeConfig> = store.get("appTheme")
): string {
  if (
    themeConfig &&
    typeof themeConfig === "object" &&
    !Array.isArray(themeConfig) &&
    "colorSchemeId" in themeConfig &&
    typeof themeConfig.colorSchemeId === "string" &&
    themeConfig.colorSchemeId.trim()
  ) {
    return themeConfig.colorSchemeId.trim();
  }
  return process.env.DAINTREE_SCREENSHOT_SCALE || nativeTheme.shouldUseDarkColors
    ? "daintree"
    : "bondi";
}

/**
 * Resolves the compositor background color for a cold-start WebContentsView.
 * Called in ProjectViewManager.createView() before loadURL so the view's
 * background clear color matches the app theme instead of defaulting to white
 * (#9573). Accent override is intentionally omitted — applyAccentOverrideToScheme
 * does not touch surface-canvas, so the base scheme value is correct.
 */
export function resolveInitialCanvasBackgroundColor(): string {
  const themeConfig = store.get("appTheme") ?? {};
  const colorSchemeId = resolveInitialColorSchemeId(themeConfig);
  let customSchemes: AppColorScheme[] = [];
  const rawSchemes = (themeConfig as Record<string, unknown>).customSchemes;
  if (rawSchemes !== undefined) {
    const result = migrateCustomSchemes(
      rawSchemes,
      appCustomSchemesReadSchema,
      appCustomSchemesWriteSchema
    );
    customSchemes = result.schemes;
  }
  const scheme = resolveAppTheme(colorSchemeId, customSchemes);
  return scheme.tokens["surface-canvas"];
}

/**
 * Builds the first-paint skeleton CSS custom-property block. Reads the
 * persisted app state and theme config synchronously, so callers on the boot
 * critical path can precompute the string once (before loadURL) instead of
 * re-reading config.json inside the dom-ready handler that gates win.show().
 * Accepts a pre-read theme config so callers that already hold one avoid a
 * redundant full-store read (every `store.get()` re-reads the config file
 * from disk).
 */
export function buildSkeletonCss(
  project?: Pick<Project, "color"> | null,
  preReadThemeConfig?: Partial<AppThemeConfig>
): string {
  const appState = store.get("appState");
  const sidebarWidth = appState?.sidebarWidth ?? 350;
  const focusMode = appState?.focusMode ?? false;

  // Resolve theme
  const themeConfig = preReadThemeConfig ?? store.get("appTheme") ?? {};
  const colorSchemeId =
    typeof themeConfig.colorSchemeId === "string" ? themeConfig.colorSchemeId : "daintree";
  // Apply lazy migration for legacy string-encoded customSchemes
  let customSchemes: AppColorScheme[] = [];
  const rawSchemes = (themeConfig as Record<string, unknown>).customSchemes;
  if (rawSchemes !== undefined) {
    const result = migrateCustomSchemes(
      rawSchemes,
      appCustomSchemesReadSchema,
      appCustomSchemesWriteSchema
    );
    customSchemes = result.schemes;
    if (result.migrated) {
      try {
        store.set("appTheme", {
          ...(themeConfig as Record<string, unknown>),
          customSchemes: result.schemes.length > 0 ? result.schemes : [],
        });
      } catch {
        // Non-fatal: config persisted but migration write failed
      }
    }
  }
  const scheme = resolveAppTheme(colorSchemeId, customSchemes);
  // Paint the destination project's accent on cold starts. Safe to call
  // unconditionally — a missing or invalid color returns the scheme unchanged.
  const themedScheme = applyAccentOverrideToScheme(scheme, project?.color);
  const themeVars = getAppThemeCssVariables(themedScheme);

  // Scope the seeded vars to `#startup-skeleton`, NOT `:root`. This stylesheet
  // is injected via user-origin `insertCSS` and is never removed — it persists
  // for the whole session. Required `--theme-*` tokens are harmless because the
  // renderer re-sets them inline on `documentElement` on every theme switch, and
  // inline (author-origin) styles outrank user-origin rules (#9333). But OPTIONAL
  // extension tokens (e.g. `--panel-grid-bg`, emitted only by light themes) are
  // REMOVED inline on a light→dark switch — with no inline value left, a `:root`
  // declaration here would win the cascade and leak the old light value until
  // restart (#9716). Scoping to `#startup-skeleton` keeps the splash themed (its
  // descendants inherit these vars) while ensuring nothing leaks into the live
  // app, whose own vars live on `:root` via applyDefaultAppTheme. `#root` is a
  // sibling of `#startup-skeleton`, so the app never inherits this block.
  const lines: string[] = ["#startup-skeleton {"];

  // Theme tokens (--theme-surface-canvas, --theme-border-default, etc.)
  for (const [prop, value] of Object.entries(themeVars)) {
    lines.push(`  ${prop}: ${value};`);
  }

  // Layout state
  lines.push(`  --skeleton-sidebar-width: ${sidebarWidth}px;`);
  lines.push(`  --skeleton-focus-mode: ${focusMode ? "1" : "0"};`);

  // Reserve space for Windows native caption buttons in the pre-React skeleton
  // (consumed by index.html's .skeleton-toolbar-right). The live Toolbar reads
  // env(titlebar-area-width) directly via the Window Controls Overlay API, so
  // this variable only covers the brief skeleton phase before WCO env vars are
  // wired up in the renderer. 138px ≈ 3 × 46px backplates on Windows 11 @ 96 DPI.
  // See issues #7951 and #8167.
  if (process.platform === "win32") {
    lines.push("  --win-caption-width: 138px;");
  }

  lines.push("}");

  // If focus mode is active, hide the skeleton sidebar
  if (focusMode) {
    lines.push("#startup-skeleton .skeleton-sidebar { display: none; }");
  }

  return lines.join("\n");
}

/**
 * Insert a (possibly precomputed) skeleton CSS string into a WebContents.
 */
export function insertSkeletonCss(wc: WebContents, css: string): void {
  void wc.insertCSS(css, { cssOrigin: "user" }).catch(() => {
    // Best-effort first-paint seed: a destroyed/navigated WebContents during
    // rapid project switching rejects here. Swallow — the index.html skeleton
    // styles carry hardcoded fallbacks, so the splash still paints.
  });
}

/**
 * Inject the first-paint skeleton CSS custom properties. When a cold-start
 * project switch supplies the destination `project`, its accent color (when
 * set) overrides the theme's native accent tokens so the skeleton paints the
 * project's brand color before React mounts (#9162). Passing `null`/`undefined`
 * (the initial-window path) leaves the resolved scheme untouched.
 */
export function injectSkeletonCss(wc: WebContents, project?: Pick<Project, "color"> | null): void {
  insertSkeletonCss(wc, buildSkeletonCss(project));
}

/**
 * Paint the destination project's name and emoji into the cold-start skeleton's
 * title element via `executeJavaScript` (#9162). CSS alone can't set text
 * content on `.skeleton-title`, so this mutates the DOM directly. Must run
 * after `dom-ready` (the element must exist) — the no-op shimmer placeholder
 * stays for projects with no resolvable name. The injected values are passed
 * through `JSON.stringify` so emoji and arbitrary names can't break out of the
 * string literal.
 */
export function injectSkeletonProjectIdentity(
  wc: WebContents,
  project: Pick<Project, "name" | "emoji"> | null | undefined
): void {
  const name = typeof project?.name === "string" ? project.name.trim() : "";
  if (!name) return;
  const emoji = typeof project?.emoji === "string" ? project.emoji.trim() : "";
  const label = emoji ? `${emoji}  ${name}` : name;
  const labelLiteral = JSON.stringify(label);
  const script = `(function(){try{var t=document.querySelector('#startup-skeleton .skeleton-title');if(t){t.textContent=${labelLiteral};t.classList.add('skeleton-title--identified');}var s=document.querySelector('#startup-skeleton .skeleton-logo-section');if(s){s.classList.add('skeleton-logo-section--identified');}}catch(e){}})();`;
  void wc.executeJavaScript(script, true).catch(() => {
    // Best-effort first-paint enhancement: a destroyed/navigated context is
    // expected during rapid project switching. Swallow — the generic skeleton
    // remains a correct fallback.
  });
}
