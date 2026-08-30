import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { useProjectStore } from "@/store/projectStore";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

interface ProjectIdentityEditorProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired as the popover hands focus back, so the pill's controlled tooltip
   * can stay down through the restoration.
   */
  onCloseAutoFocus?: () => void;
}

const PILL_SELECTOR = '[data-testid="project-switcher-trigger"]';

function findPill(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PILL_SELECTOR);
}

/**
 * Hands the shared close-time focus policy somewhere to put focus.
 *
 * It records the trigger, and an anchored popover has none — so without this
 * every pointer close falls through to Radix, which focuses a null trigger and
 * leaves focus on `document.body`. Rendered inside `Popover` because the
 * context only exists below the root.
 */
function PillRestoreTarget({ open }: { open: boolean }) {
  const overlay = useOverlayFocusRestore();
  useEffect(() => {
    if (!open) return;
    overlay?.setRestoreTarget(findPill());
  }, [open, overlay]);
  return null;
}

/**
 * Display-identity editing for the current project — the name and the emoji,
 * in one popover anchored under the toolbar pill.
 *
 * Opened from the pill's context menu, never from a click on the pill itself.
 * It used to own a transparent 28px overlay sitting on the emoji glyph, so a
 * left-click there edited the project instead of opening the switcher. That
 * put a rare action inside the hit box of a very frequent one with no visible
 * boundary, and the two surfaces were easy to confuse: both open with a text
 * field focused, so the switcher's own click-type-Enter muscle memory landed
 * in the name field and renamed the project (#12093).
 *
 * Anchored rather than triggered: the pill is already wrapped by the switcher
 * popover, the context menu and the tooltip, and it has one job on click. This
 * renders as a sibling of the pill inside the toolbar's project group, but as
 * a zero-height, pointer-transparent anchor rather than the old overlay — it
 * borrows the group's position and can never take a click of its own.
 */
export function ProjectIdentityEditor({
  project,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: ProjectIdentityEditorProps) {
  const updateProject = useProjectStore((state) => state.updateProject);
  const [draftName, setDraftName] = useState(project.name);
  // Only a name the user actually typed is worth writing back. Without this,
  // an untouched draft would overwrite a rename that landed from another
  // window while this popover sat open.
  const [isNameDirty, setIsNameDirty] = useState(false);
  // Whether the last interaction in this opening came from the keyboard. Read
  // for exactly one decision — see the close handler — and deliberately not a
  // second copy of the shared policy, which still owns every pointer close.
  const lastInputWasKeyboardRef = useRef(false);

  const resetDraft = useCallback(() => {
    setDraftName(project.name);
    setIsNameDirty(false);
  }, [project.name]);

  // Re-seed when the popover opens, and whenever the project changes underneath
  // it, so a draft left over from another project can never be committed.
  // Adjusted during render rather than in an effect: keying an effect on
  // `project.name` would wipe the field mid-edit the moment an optimistic
  // rename lands, and omitting it needs an exhaustive-deps suppression that
  // opts the whole component out of the React Compiler.
  const seedKey = `${project.id}:${open ? "open" : "closed"}`;
  const [lastSeedKey, setLastSeedKey] = useState(seedKey);
  if (lastSeedKey !== seedKey) {
    setLastSeedKey(seedKey);
    setDraftName(project.name);
    setIsNameDirty(false);
  }

  /**
   * Single write path for both halves of the identity. The emoji picker closes
   * the popover programmatically, which does NOT fire `onOpenChange`, so an
   * emoji-only commit has to carry any pending name edit with it or the rename
   * is silently dropped.
   */
  const commitIdentity = useCallback(
    (pickedEmoji?: string) => {
      const updates: { name?: string; emoji?: string } = {};

      const trimmed = draftName.trim();
      // An emptied field means "no change" rather than "erase the name" — there
      // is no such thing as a nameless project.
      if (isNameDirty && trimmed && trimmed !== project.name) {
        updates.name = trimmed;
      }
      if (pickedEmoji !== undefined && pickedEmoji !== project.emoji) {
        updates.emoji = pickedEmoji;
      }

      if (Object.keys(updates).length === 0) {
        resetDraft();
        return;
      }

      // The store rolls back and rethrows on failure; swallow here so a failed
      // write can't surface as an unhandled rejection. It already logs and sets
      // the store's error state.
      void updateProject(project.id, updates).catch(() => {
        resetDraft();
      });
    },
    [draftName, isNameDirty, project.id, project.name, project.emoji, updateProject, resetDraft]
  );

  const handleEmojiSelect = useCallback(
    (picked: string) => {
      commitIdentity(picked);
      onOpenChange(false);
    },
    [commitIdentity, onOpenChange]
  );

  // While a project still carries the default tree, offer the name-derived
  // suggestion as a one-click accept. Derived from the draft so renaming and
  // accepting a suggestion in one pass suggests for the NEW name. The tree is
  // the "unset" signal, so the suggestion is offered here rather than silently
  // stored at creation.
  const suggestion =
    project.emoji === DEFAULT_PROJECT_EMOJI
      ? suggestProjectEmoji(draftName.trim() || project.name)
      : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) commitIdentity();
        onOpenChange(next);
      }}
    >
      <PillRestoreTarget open={open} />
      {/* Spans the group's width along its bottom edge, so the popover centres
          under the pill. Zero height and no pointer surface: the whole point of
          this component's rewrite is that nothing here is clickable. */}
      <PopoverAnchor asChild>
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0" />
      </PopoverAnchor>
      <PopoverContent
        className="w-auto p-0"
        align="center"
        aria-label="Edit project identity"
        // Hand focus to the name field instead of letting Radix park it on the
        // popover container.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          lastInputWasKeyboardRef.current = false;
        }}
        // Modality, tracked for the close handler below and nothing else. A
        // keydown supersedes an earlier pointer press for the same reason the
        // shared policy's own does: a click that did not close the popover —
        // into the name field, say — must not decide how a later Escape ends.
        onKeyDown={() => {
          lastInputWasKeyboardRef.current = true;
        }}
        onPointerDown={() => {
          lastInputWasKeyboardRef.current = false;
        }}
        onPointerDownOutside={() => {
          lastInputWasKeyboardRef.current = false;
        }}
        // Escape means "cancel the edit". Radix's dismissable layer sees the
        // key on a document CAPTURE listener, so its default dismissal would
        // fire `onOpenChange` — and with it the commit — before any handler on
        // the input could revert the draft. Take the close over manually so the
        // revert lands first and no commit runs at all. The capture listener
        // also means the content's own `onKeyDown` may never see this key, so
        // the modality is recorded here too.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          lastInputWasKeyboardRef.current = true;
          resetDraft();
          onOpenChange(false);
        }}
        // Pointer closes belong to the shared policy in `overlay-focus-restore`
        // — it runs straight after this one, and `PillRestoreTarget` has given
        // it the pill to aim at. Claiming them here instead would steal focus
        // from whatever the closing click just opened: dismissing this popover
        // by clicking the pill opens the switcher and focuses its search box,
        // and a blanket restore would yank focus straight back out of it.
        //
        // The keyboard close is the one case the shared policy cannot cover:
        // it defers to Radix, which restores to a TRIGGER, and an anchored
        // popover has none — so focus lands on `document.body` and the next Tab
        // restarts from the top of the document.
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.();
          // Cleared before the branch, not inside it: `onOpenAutoFocus` is the
          // other reset, and Radix skips dispatching it when focus is already
          // inside the content — which `autoFocus` on the name field arranges
          // on most openings. So this is the one that always runs.
          const wasKeyboard = lastInputWasKeyboardRef.current;
          lastInputWasKeyboardRef.current = false;
          if (!wasKeyboard) return;
          event.preventDefault();
          // Ringed on purpose — a keyboard user has to see where they landed.
          findPill()?.focus({ preventScroll: true });
        }}
      >
        <div className="flex flex-col">
          <div className="flex flex-col gap-1.5 border-b border-border-default p-3">
            <label
              htmlFor="project-identity-name"
              className="text-xs font-medium text-text-secondary"
            >
              Project name
            </label>
            <input
              id="project-identity-name"
              type="text"
              // The popover exists to edit this field, so it takes focus on
              // open (onOpenAutoFocus above defers to it).
              autoFocus
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                setIsNameDirty(true);
              }}
              onKeyDown={(event) => {
                // Escape is handled by onEscapeKeyDown on the content — Radix
                // sees it first, on a document capture listener.
                if (event.key === "Enter") {
                  event.preventDefault();
                  lastInputWasKeyboardRef.current = true;
                  commitIdentity();
                  onOpenChange(false);
                }
              }}
              className="w-[280px] rounded-[var(--radius-md)] border border-border-default bg-surface-canvas px-3 py-1.5 text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
              placeholder={project.name}
            />
            {suggestion && (
              <button
                type="button"
                onClick={() => handleEmojiSelect(suggestion)}
                className="flex items-center gap-2 self-start rounded-[var(--radius-md)] px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-overlay-subtle"
              >
                <span className="text-base leading-none">{suggestion}</span>
                <span>Use suggested</span>
              </button>
            )}
          </div>
          <EmojiPicker onEmojiSelect={({ emoji }) => handleEmojiSelect(emoji)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
