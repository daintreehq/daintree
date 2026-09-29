import { cn } from "../kit/cn.js";
import { resolveMockCI, useMockKit, type MockCIVisual } from "./MockKitContext.js";

/** A pull request's checks mark: a status the kit knows (e.g. "pending"), or a visual. */
export function MockCIGlyph({ status }: { status: string | MockCIVisual }) {
  const visual = resolveMockCI(useMockKit(), status);
  if (!visual) return null;
  return visual.kind === "icon" ? (
    <visual.Icon className={cn("size-3.5!", visual.colorClass)} aria-hidden="true" />
  ) : (
    <span className={cn("size-2.5 rounded-full", visual.colorClass)} aria-hidden="true" />
  );
}
