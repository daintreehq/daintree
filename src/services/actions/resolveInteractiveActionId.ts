import type { ActionId } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";

/**
 * The action a person's pick of `actionId` runs: its palette redirect target
 * when it declares one, otherwise itself.
 *
 * A redirect marks a headless, argument-taking action with an interactive
 * sibling (`git.commit` → Review Hub). A shortcut or HUD row dispatches with no
 * arguments, so running the source would only fail its validation; every
 * surface a person drives resolves through here, the way the palette does.
 * One hop, like the palette: a missing target reaches dispatch as NOT_FOUND
 * rather than falling back to the source.
 */
export function resolveInteractiveActionId(actionId: ActionId): ActionId {
  return (
    actionService.get(actionId, undefined, { includeSchemas: false })?.paletteRedirectTo ??
    actionId
  );
}
