/**
 * How far this document's startup got, written onto the cold-start skeleton so
 * `public/skeleton-stuck.js` (a classic script, with no way to import this) can
 * say so in its report when the stuck card appears (#16401). No attribute means
 * hydration never started; `ready` means the skeleton is on its way out and the
 * card has nothing to report.
 */
export type StartupStage = "hydrating" | "ready";

export function markStartupStage(stage: StartupStage): void {
  if (typeof document === "undefined") return;
  document.getElementById("startup-skeleton")?.setAttribute("data-startup-stage", stage);
}
