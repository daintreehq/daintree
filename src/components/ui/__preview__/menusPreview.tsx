import "./menusShims";
// The app registers its Trusted Types policies at boot (main.tsx); the dev CSP
// stamped on this entry enforces them, and the toolbar's module graph has sinks.
import "@/lib/trustedTypesPolicy";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { useAppThemeStore } from "@/store/appThemeStore";
import "@/index.css";

/**
 * Standalone gallery for the menus and popovers no other preview page reaches.
 *
 * Each scene mounts the REAL component against seeded stores and the real theme
 * tokens and `index.css`, closed — the spec (`menus-popovers-review.spec.ts`)
 * opens it the way a person would, so what gets photographed is the product's
 * own open state rather than a forced one.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?scene=<id>               toolbar | grid | notifications | toaster |
 *                             browser-toolbar | browser-more | devpreview-console |
 *                             devpreview-refused | diff-notes |
 *                             file-browser-options | markdown-text-size |
 *                             worktree-resource
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const sceneId = params.get("scene") ?? "toolbar";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
// Brand marks resolve their inks from this store, not from the tokens on the root.
useAppThemeStore.setState({ selectedSchemeId: themeId });
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// Radix loads lazily; prime it so the first right-click lands on a live trigger.
await primeRadix();

async function loadScene(): Promise<ReactNode> {
  if (sceneId === "toolbar") {
    const { ToolbarScene } = await import("./menusToolbarScene");
    return <ToolbarScene />;
  }
  if (sceneId === "grid") {
    const { GridScene, seedGridScene } = await import("./menusGridScene");
    seedGridScene();
    return <GridScene />;
  }
  if (sceneId === "notifications" || sceneId === "toaster") {
    const { NotificationsScene, seedNotificationsScene } =
      await import("./menusNotificationsScene");
    seedNotificationsScene(sceneId);
    return (
      <div className="p-4">
        <NotificationsScene scene={sceneId} />
      </div>
    );
  }
  const { GALLERY_SCENES, GallerySceneView, seedGalleryScene } = await import("./menusScenes");
  const scene = GALLERY_SCENES.find((s) => s === sceneId);
  if (!scene) {
    throw new Error(
      `unknown scene "${sceneId}" — expected toolbar, grid, notifications, toaster or one of ${GALLERY_SCENES.join(", ")}`
    );
  }
  seedGalleryScene(scene);
  return (
    <div className="p-4">
      <GallerySceneView scene={scene} />
    </div>
  );
}

const { LazyMotion, domAnimation } = await import("framer-motion");
const content = await loadScene();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <div data-preview-shell data-scene={sceneId}>
          {content}
        </div>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
