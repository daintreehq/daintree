/**
 * File browser viewer visual-review harness.
 *
 * The companion to `file-browser-review.spec.ts`, which covers the tree
 * column's chrome. This one covers the other half: the path from picking an
 * entry in the tree to reading it in the viewer, for every kind of thing the
 * viewer can be asked to show — a folder, code, Markdown in both modes, a
 * raster image, an SVG, a PDF, audio, video, a read still in flight, and each
 * way a file can turn out to be unavailable.
 *
 * Every state is captured twice: with the panel at a comfortable width, and
 * with the window shrunk until the viewer column is the narrow strip beside a
 * minimum-width tree. The narrow pass is where file identity and the toolbar's
 * controls are under the most pressure.
 *
 * Media fixtures are generated at run time rather than committed: the PNG and
 * WAV are encoded here, the PDF is written by hand, and the MP4 comes from
 * ffmpeg (required — the run fails rather than skipping the video states).
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_FBVIEWER is set.
 *
 *   npm run build
 *   DAINTREE_SHOT_FBVIEWER=1 DAINTREE_SHOT_DIR=/tmp/fbv \
 *     npx playwright test --project=screenshots file-browser-viewer-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FBVIEWER  required — any truthy value
 *   DAINTREE_SHOT_DIR       output directory (default: artifacts/file-browser-viewer-shots)
 *   DAINTREE_SHOT_THEME     comma-separated theme ids (default: daintree)
 *   DAINTREE_SHOT_WIDTHS    comma-separated subset of "wide,narrow" (default: both)
 *   DAINTREE_SHOT_ONLY      comma-separated state filter
 */

import { test, type ElectronApplication, type Page, type Locator } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { deflateSync, crc32 } from "zlib";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectDelay, clearAllFaults } from "../helpers/ipcFaults";
import { T_MEDIUM } from "../helpers/timeouts";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_FBVIEWER);
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree").split(",").filter(Boolean);
const WIDTHS = (process.env.DAINTREE_SHOT_WIDTHS ?? "wide,narrow").split(",").filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "file-browser-viewer-shots");

/**
 * Window sizes per width pass. Narrow is chosen so that, beside the app's own
 * worktree sidebar and a minimum-width tree column, the viewer lands near the
 * 300px floor the audio control and toolbar have to survive.
 */
const WINDOW_SIZES: Record<string, { width: number; height: number }> = {
  wide: { width: 1560, height: 940 },
  narrow: { width: 900, height: 820 },
};

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /* The delayed pulse starts at opacity 0 and relies on its animation to
     appear; with animations zeroed above it would never paint, so a skeleton
     past its gate is pinned visible instead. */
  .animate-pulse-delayed { animation: none !important; opacity: 1 !important; }
`;

// ---------------------------------------------------------------------------
// Fixture generation

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** A 1200x675 RGBA banner: a diagonal gradient with a translucent disc, so zoom and the checkerboard both read. */
function encodeBannerPng(width = 1200, height = 675): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const cx = width * 0.62;
  const cy = height * 0.5;
  const r = height * 0.32;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      const t = (x + y) / (width + height);
      let red = Math.round(30 + 60 * t);
      let green = Math.round(110 + 90 * (1 - t));
      let blue = Math.round(120 + 110 * t);
      let alpha = 255;
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        red = 245;
        green = 196;
        blue = 80;
        alpha = 210;
      }
      // A transparent band on the left edge exposes the checkerboard.
      if (x < width * 0.12) alpha = Math.round(255 * (x / (width * 0.12)));
      raw[i] = red;
      raw[i + 1] = green;
      raw[i + 2] = blue;
      raw[i + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Two seconds of a soft 440Hz tone, 16-bit mono PCM. */
function encodeWav(seconds = 2, rate = 22050): Buffer {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / 2000, (samples - i) / 2000);
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000 * envelope),
      i * 2
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A one-page PDF with a heading and body text, xref offsets computed so PDFium opens it cleanly. */
function encodePdf(): Buffer {
  const stream =
    "BT /F1 24 Tf 72 720 Td (Design brief) Tj ET\n" +
    "BT /F1 12 Tf 72 690 Td (File browser viewer - review fixture) Tj ET\n" +
    "BT /F1 12 Tf 72 670 Td (This page exists so the PDF state has real content.) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const CONTENT_PANEL_SOURCE = `import { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";
import type { PanelLocation } from "@shared/types/panel";

export interface ContentPanelProps {
  id: string;
  title: string;
  kind: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location: PanelLocation;
  onFocus: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * The frame every grid panel renders inside: a header with the panel's
 * identity and window controls, and a body that fills the remaining height.
 */
export function ContentPanel({
  id,
  title,
  kind,
  isFocused,
  isMaximized = false,
  location,
  onFocus,
  onClose,
  children,
}: ContentPanelProps) {
  const [isHovered, setIsHovered] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const frameClass = useMemo(
    () =>
      cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border",
        isFocused ? "border-border-strong" : "border-border-default",
        isMaximized && "rounded-none"
      ),
    [isFocused, isMaximized]
  );

  return (
    <div
      ref={frameRef}
      data-panel-id={id}
      data-panel-kind={kind}
      data-location={location}
      className={frameClass}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={onFocus}
    >
      <PanelHeader title={title} isHovered={isHovered} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
`;

const MARKDOWN_SOURCE = `# State management

Every store in the renderer is a Zustand store created once per project view.
Cross-store reads go through \`storeAccessors.ts\` so no store imports a partner
at module evaluation time.

## Store families

| Family | Scope | Persisted |
| --- | --- | --- |
| Panels | per project view | yes |
| Worktrees | per project view | no |
| Preferences | app-global | yes |

## Rules

1. Never import a partner store at module scope.
2. Derive, don't duplicate — selectors over copies.
3. Persist only what a restart needs.

> The worktree store is the one per-view factory; everything else is a
> module-level \`create()\`.

\`\`\`ts
export const usePanelStore = create<PanelState>()((set) => ({
  panels: [],
  addPanel: (panel) => set((state) => ({ panels: [...state.panels, panel] })),
}));
\`\`\`

### See also

- [Notification system](./notification-system.md)
- [Store init order](./store-init-order.md)
`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="240" height="240">
  <rect x="8" y="8" width="104" height="104" rx="22" fill="#2f7d6d"/>
  <path d="M36 84 L60 30 L84 84 Z" fill="#f5c450"/>
  <circle cx="60" cy="70" r="10" fill="#1d3b35"/>
</svg>
`;

function seedFiles(dir: string): void {
  const write = (relative: string, contents: string | Buffer) => {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };

  write("src/components/Panel/ContentPanel.tsx", CONTENT_PANEL_SOURCE);
  write("src/components/Panel/PanelHeader.tsx", "export const PanelHeader = () => null;\n");
  write(
    "src/components/Panel/useContentPanelKeyboardNavigationAndFocusRestoration.ts",
    "export function useContentPanelKeyboardNavigationAndFocusRestoration() {}\n"
  );
  write("src/lib/utils.ts", "export const cn = (...a: string[]) => a.join(' ');\n");
  write("src/store/panelStore.ts", "export const usePanelStore = () => null;\n");
  write("docs/architecture/state-management.md", MARKDOWN_SOURCE);
  write("docs/architecture/notification-system.md", "# Notifications\n\nRouting matrix.\n");
  write("docs/specs/design-brief.pdf", encodePdf());
  write("docs/e2e-testing.md", "# E2E testing\n\nTiers and buckets.\n");
  write("assets/brand/hero-banner.png", encodeBannerPng());
  write("assets/brand/logo.svg", LOGO_SVG);
  write("assets/brand/corrupt-thumbnail.png", Buffer.from("this is not a png at all\n"));
  write("assets/audio/notification.wav", encodeWav());
  write("assets/video/screen-recording.mov", Buffer.alloc(2048, 1));
  write(
    "bin/fixture-tool",
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe])
  );
  write(
    "logs/server.log",
    Array.from(
      { length: 14000 },
      (_, i) =>
        `2026-09-23T06:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} served in ${i % 97}ms\n`
    ).join("")
  );
  write("README.md", "# Fixture project\n\nA project tree for the viewer review harness.\n");
  write("package.json", '{\n  "name": "fixture-project",\n  "version": "1.0.0"\n}\n');

  const video = path.join(dir, "assets/video/demo-walkthrough.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24:duration=3",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-y",
      video,
    ],
    { stdio: "inherit" }
  );

  // Commit the tree, then dirty two files, so the no-selection state shows a
  // realistic change summary rather than every file in the fixture as new.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("add", "-A");
  git("-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-qm", "seed");
  write(
    "src/components/Panel/ContentPanel.tsx",
    CONTENT_PANEL_SOURCE.replace(
      "isMaximized = false",
      "isMaximized = false,\n  // focus ring follows the frame"
    )
  );
  write(
    "docs/architecture/state-management.md",
    `${MARKDOWN_SOURCE}\n## Changelog\n\n- Added store families table.\n`
  );
}

// ---------------------------------------------------------------------------
// Harness plumbing

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const stepFailures: string[] = [];

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { worktrees?: Array<{ id: string; isMain?: boolean }>; panelId?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function mainWorktreeId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const listed = await dispatchAction(page, "worktree.list");
    const id = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
    if (id !== undefined) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("main worktree never resolved");
}

async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }) {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
    win?.setSize(s.width, s.height);
  }, size);
}

test("file browser review — viewer formats and states", async () => {
  test.setTimeout(20 * 60_000);
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FBVIEWER is required for the file browser viewer capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FBVIEWER to run the file browser viewer capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const themeId of THEMES) {
    for (const width of WIDTHS) {
      const size = WINDOW_SIZES[width];
      if (!size) throw new Error(`unknown width "${width}"`);
      const repo = createFixtureRepo({ name: "file-browser-viewer-shots" });
      seedFiles(repo.dir);
      const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-fbvshot-"));
      let ctx: AppContext | undefined;
      const prefix = `${themeId}-${width}-`;

      try {
        ctx = await launchApp({
          userDataDir,
          screenshotScale: SCALE,
          windowSize: size,
          env: { DAINTREE_E2E_FAULT_MODE: "1" },
          extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
        });
        const app = ctx.app;
        const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Fixture Project");
        if (themeId !== "daintree") await setAppTheme(page, themeId);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await setWindowSize(app, size);
        await settle(page, 800);

        const worktreeId = await mainWorktreeId(page);
        const opened = await dispatchAction(page, "worktree.openFileBrowserPanel", { worktreeId });
        if (opened.ok === false) {
          throw new Error(`openFileBrowserPanel failed: ${opened.error?.message ?? "unknown"}`);
        }
        const panelId = opened.result?.panelId;
        if (!panelId) throw new Error("openFileBrowserPanel returned no panelId");

        const panel = page.locator(`[data-panel-id="${panelId}"]`);
        await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
        await settle(page, 1200);

        if (width === "narrow") {
          // Tree to its minimum so the viewer gets every pixel it can.
          const grip = panel.locator('[data-testid="file-browser-sidebar-resize"]');
          await grip.focus();
          for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await settle(page, 500);
        }

        const tree = panel.locator('[role="tree"]');
        const row = (name: string): Locator =>
          tree.getByRole("treeitem", { name, exact: true }).first();

        /** Expand each ancestor, then click the leaf. */
        const openPath = async (relative: string): Promise<void> => {
          const parts = relative.split("/");
          for (const part of parts.slice(0, -1)) {
            const item = row(part);
            await item.waitFor({ state: "visible", timeout: T_MEDIUM });
            if ((await item.getAttribute("aria-expanded")) !== "true") {
              await item.click();
              await settle(page, 350);
            }
          }
          await row(parts[parts.length - 1]!).click({ timeout: T_MEDIUM });
        };

        const collapseAll = async (): Promise<void> => {
          await panel.locator('[data-testid="file-browser-view-options"]').first().click();
          await settle(page, 300);
          const item = page.locator('[data-testid="file-browser-collapse-all"]');
          if ((await item.getAttribute("data-disabled")) !== null) {
            await page.keyboard.press("Escape");
          } else {
            await item.click();
          }
          await settle(page, 400);
        };

        const snap = async (slug: string, waitMs = 700): Promise<void> => {
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.mouse.move(2, 2);
          await settle(page, waitMs);
          const file = path.join(OUTPUT_DIR, `${prefix}${slug}.png`);
          await panel.screenshot({ path: file, type: "png" });
        };

        const state = async (name: string, fn: () => Promise<void>): Promise<void> => {
          if (ONLY.length > 0 && !ONLY.includes(name)) return;
          try {
            await fn();
          } catch (error) {
            stepFailures.push(`${prefix}${name}: ${String(error).slice(0, 300)}`);
            console.warn(`[fbv-shots] ${prefix}${name} failed:`, String(error).slice(0, 300));
          }
        };

        await state("idle", async () => {
          await snap("01-idle-changes");
        });

        await state("folder", async () => {
          await row("assets").click();
          await settle(page, 300);
          await row("brand").click();
          await settle(page, 300);
          // Enter on the cursor row is the tree's "show contents" gesture.
          await page.keyboard.press("Enter");
          await snap("02-folder-listing");
          await collapseAll();
        });

        await state("code", async () => {
          await openPath("src/components/Panel/ContentPanel.tsx");
          await snap("03-code");
        });

        await state("code-long-name", async () => {
          await openPath(
            "src/components/Panel/useContentPanelKeyboardNavigationAndFocusRestoration.ts"
          );
          await snap("04-code-long-name");
          await collapseAll();
        });

        /**
         * Pick a view mode through whichever control the row is showing: the
         * segmented pair where it fits, or the mode menu the tightest widths
         * fold it into. Menus are closed by picking an item, never Escape.
         */
        const setMode = async (label: "Source" | "Rendered"): Promise<void> => {
          const segment = panel.getByRole("button", { name: label, exact: true });
          if ((await segment.count()) > 0) {
            await segment.click();
          } else {
            await panel.getByRole("button", { name: /^View mode:/ }).click();
            await settle(page, 300);
            await page.getByRole("menuitemradio", { name: label }).click();
          }
          await settle(page, 400);
        };

        await state("markdown", async () => {
          await openPath("docs/architecture/state-management.md");
          await snap("05-markdown-rendered", 1200);
          await setMode("Source");
          await snap("06-markdown-source");
          await setMode("Rendered");
          await collapseAll();
        });

        await state("menus", async () => {
          // The two menus narrow widths fold controls into, open. Whole window
          // rather than the panel: Radix portals menus to the body. Escape is
          // safe for a dropdown; it is context menus that black-screen.
          await openPath("docs/architecture/state-management.md");
          await settle(page, 800);
          const more = panel.getByRole("button", { name: "More actions" });
          if ((await more.count()) > 0) {
            await more.click();
            await settle(page, 400);
            await page.screenshot({
              path: path.join(OUTPUT_DIR, `${prefix}19-more-actions-open.png`),
            });
            await page.keyboard.press("Escape");
            await settle(page, 300);
          }
          const modeMenu = panel.getByRole("button", { name: /^View mode:/ });
          if ((await modeMenu.count()) > 0) {
            await modeMenu.click();
            await settle(page, 400);
            await page.screenshot({
              path: path.join(OUTPUT_DIR, `${prefix}20-mode-menu-open.png`),
            });
            await page.getByRole("menuitemradio", { name: "Rendered" }).click();
            await settle(page, 300);
          }
          await collapseAll();
        });

        await state("image", async () => {
          await openPath("assets/brand/hero-banner.png");
          await snap("07-image", 1200);
        });

        await state("svg", async () => {
          await openPath("assets/brand/logo.svg");
          await snap("08-svg", 900);
        });

        await state("image-broken", async () => {
          await openPath("assets/brand/corrupt-thumbnail.png");
          await snap("09-image-broken", 1200);
          await collapseAll();
        });

        await state("pdf", async () => {
          await openPath("docs/specs/design-brief.pdf");
          await snap("10-pdf", 2500);
          await collapseAll();
        });

        await state("audio", async () => {
          await openPath("assets/audio/notification.wav");
          await snap("11-audio", 1500);
          await collapseAll();
        });

        await state("video", async () => {
          await openPath("assets/video/demo-walkthrough.mp4");
          await snap("12-video", 2000);
        });

        await state("video-unsupported", async () => {
          await openPath("assets/video/screen-recording.mov");
          await snap("13-video-unsupported");
          await collapseAll();
        });

        await state("binary", async () => {
          await openPath("bin/fixture-tool");
          await snap("14-binary");
          await collapseAll();
        });

        await state("too-large", async () => {
          await openPath("logs/server.log");
          await snap("15-too-large");
          await collapseAll();
        });

        await state("loading", async () => {
          // Hold the next read long enough that the 400ms gate opens and the
          // skeleton paints, then capture inside the window.
          await injectDelay(app, "files:read", 6000);
          await openPath("docs/e2e-testing.md");
          await snap("16-loading", 1500);
          await clearAllFaults(app);
          await settle(page, 5000);
        });

        await state("missing", async () => {
          await openPath("docs/architecture/notification-system.md");
          await settle(page, 600);
          rmSync(path.join(repo.dir, "docs/architecture/notification-system.md"));
          await settle(page, 3500);
          await snap("17-missing");
          await collapseAll();
        });

        await state("tree-collapsed", async () => {
          await openPath("src/components/Panel/ContentPanel.tsx");
          await settle(page, 400);
          await panel.locator('[data-testid="file-browser-sidebar-toggle"]').click();
          await snap("18-tree-collapsed-code");
          await panel.locator('[data-testid="file-browser-sidebar-toggle"]').click();
          await settle(page, 500);
        });
        // The standalone file panel shares the toolbar and the unavailable
        // states, so it is captured alongside for the consistency roll-out:
        // the browser panel closes first, then each file panel has the grid to
        // itself at this pass's width.
        await state("file-panel", async () => {
          await dispatchAction(page, "terminal.close", { terminalId: panelId });
          await settle(page, 800);
          const samples: Array<[string, string]> = [
            ["docs/architecture/state-management.md", "21-file-panel-markdown"],
            ["src/components/Panel/ContentPanel.tsx", "22-file-panel-code"],
            ["bin/fixture-tool", "23-file-panel-binary"],
            ["assets/video/screen-recording.mov", "24-file-panel-unsupported"],
            ["assets/brand/corrupt-thumbnail.png", "25-file-panel-broken-image"],
          ];
          for (const [relative, slug] of samples) {
            const result = await dispatchAction(page, "file.openPanel", {
              path: path.join(repo.dir, relative),
            });
            const filePanelId = result.result?.panelId;
            if (!filePanelId) throw new Error(`file.openPanel gave no panel for ${relative}`);
            const filePanel = page.locator(`[data-panel-id="${filePanelId}"]`);
            await filePanel.waitFor({ state: "visible", timeout: T_MEDIUM });
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await page.mouse.move(2, 2);
            await settle(page, 1500);
            await filePanel.screenshot({ path: path.join(OUTPUT_DIR, `${prefix}${slug}.png`) });
            await dispatchAction(page, "terminal.close", { terminalId: filePanelId });
            await settle(page, 600);
          }
        });
      } finally {
        if (ctx) await closeApp(ctx.app);
        repo.cleanup();
      }
    }
  }

  const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  if (stepFailures.length > 0) {
    throw new Error(
      `[fbv-shots] ${stepFailures.length} state(s) failed:\n${stepFailures.join("\n")}\n` +
        `(${written.length} PNGs written)`
    );
  }
  if (written.length === 0) throw new Error("[fbv-shots] no PNGs were written");
  console.log(`[fbv-shots] wrote ${written.length} PNGs to ${OUTPUT_DIR}`);
});
