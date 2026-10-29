/**
 * The shared exit tier, here rather than in the renderer's animationUtils
 * because main draws one exit of its own: the host switch screen's handoff
 * across a view swap (electron/window/switchScreenHandoff.ts). The renderer
 * reads both through src/lib/animationUtils.ts.
 */
export const UI_EXIT_DURATION = 120;
export const UI_EXIT_EASING = "cubic-bezier(0.2, 0, 0.7, 0)";
