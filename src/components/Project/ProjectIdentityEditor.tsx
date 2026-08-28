import { useCallback, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { useProjectStore } from "@/store/projectStore";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

interface ProjectIdentityEditorProps {
  project: Project;
}

const PILL_SELECTOR = '[data-testid="project-switcher-trigger"]';

/**
 * One-click identity editing for the toolbar project pill: the emoji becomes
 * its own target that opens a popover holding the name field and the full
 * picker.
 *
 * Rendered as a SIBLING of the pill button, never nested inside it — the pill
 * is already wrapped by the switcher popover, context-menu and tooltip
 * triggers, and nesting a fourth interactive element there produces invalid
 * nested-button markup and fires both handlers on one click (#6928). The
 * transparent overlay sits exactly over the pill's own emoji glyph, so the
 * pill's layout and styling are untouched.
 *
 * Being a sibling means the pill's Radix triggers never see pointer activity
 * over this region, so right-click and hover are replayed onto the pill below
 * (see `replayOnPill`) to keep the project context menu and the identity
 * tooltip alive across the whole pill.
 */
export function ProjectIdentityEditor({ project }: ProjectIdentityEditorProps) {
  const updateProject = useProjectStore((state) => state.updateProject);
  const overlayRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  // Only a name the user actually typed is worth writing back. Without this,
  // an untouched draft would overwrite a rename that landed from another
  // window while this popover sat open.
  const [isNameDirty, setIsNameDirty] = useState(false);

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
  const seedKey = `${project.id}:${isOpen ? "open" : "closed"}`;
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
      setIsOpen(false);
    },
    [commitIdentity]
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

  // The pill renders alongside this overlay inside the toolbar's project group.
  const findPill = useCallback(
    () => overlayRef.current?.parentElement?.querySelector<HTMLElement>(PILL_SELECTOR) ?? null,
    []
  );

  /**
   * Re-fire a native event on the pill so its Radix triggers react as if the
   * pointer had reached them. `PointerEvent` is not constructible in every test
   * environment; `MouseEvent` carries everything these triggers read.
   */
  const replayOnPill = useCallback(
    (type: string, init: MouseEventInit) => {
      const pill = findPill();
      if (!pill) return;
      const Ctor: typeof MouseEvent =
        typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      pill.dispatchEvent(new Ctor(type, { bubbles: true, ...init }));
    },
    [findPill]
  );

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) commitIdentity();
        setIsOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={overlayRef}
          type="button"
          // Joins the toolbar's roving-tabindex domain in DOM order (it renders
          // just before the pill), so it is one arrow stop rather than a stray
          // extra Tab stop outside the model.
          data-toolbar-item=""
          data-project-identity-trigger=""
          aria-label={`Edit identity for ${project.name}, currently ${project.emoji}`}
          // The pill owns the project context menu (pin, copy path, locate,
          // settings, close); this overlay has none of its own, so hand the
          // right-click straight down to it.
          onContextMenu={(event) => {
            event.preventDefault();
            replayOnPill("contextmenu", {
              cancelable: true,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }}
          // Radix's tooltip trigger opens on `pointermove`, so one replayed
          // move per entry is enough to raise the pill's identity tooltip.
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            replayOnPill("pointermove", {});
          }}
          onPointerLeave={(event) => {
            const pill = findPill();
            const next = event.relatedTarget;
            // Sliding onto the rest of the pill leaves it natively hovered;
            // closing here would blink the tooltip shut and straight back open.
            if (!pill || (next instanceof Node && pill.contains(next))) return;
            // React synthesises `onPointerLeave` from `pointerout`, so a raw
            // `pointerleave` dispatch would never reach the trigger's handler.
            // It also reports `window` when the pointer left the React tree
            // entirely, which is not a valid `relatedTarget` to construct with.
            replayOnPill("pointerout", { relatedTarget: next instanceof Element ? next : null });
          }}
          className="pointer-events-auto absolute left-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 rounded-[var(--radius-md)] bg-transparent transition-colors hover:bg-overlay-subtle focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1"
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align="start"
        aria-label="Edit project identity"
        // Hand focus to the name field instead of letting Radix park it on the
        // popover container.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        // Escape means "cancel the edit". Radix's dismissable layer sees the
        // key on a document CAPTURE listener, so its default dismissal would
        // fire `onOpenChange` — and with it the commit — before any handler on
        // the input could revert the draft. Take the close over manually so the
        // revert lands first and no commit runs at all.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          resetDraft();
          setIsOpen(false);
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
                  commitIdentity();
                  setIsOpen(false);
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
