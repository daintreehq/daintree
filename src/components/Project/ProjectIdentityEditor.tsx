import { useCallback, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { useProjectStore } from "@/store/projectStore";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

interface ProjectIdentityEditorProps {
  project: Project;
}

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
 */
export function ProjectIdentityEditor({ project }: ProjectIdentityEditorProps) {
  const updateProject = useProjectStore((state) => state.updateProject);
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
          type="button"
          // Joins the toolbar's roving-tabindex domain in DOM order (it renders
          // just before the pill), so it is one arrow stop rather than a stray
          // extra Tab stop outside the model.
          data-toolbar-item=""
          data-project-identity-trigger=""
          aria-label={`Edit identity for ${project.name}, currently ${project.emoji}`}
          className="pointer-events-auto absolute left-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 rounded-[var(--radius-md)] bg-transparent transition-colors hover:bg-overlay-subtle focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
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
          <div className="flex flex-col gap-1.5 border-b border-daintree-border p-3">
            <label
              htmlFor="project-identity-name"
              className="text-xs font-medium text-daintree-text/60"
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
              className="w-[280px] rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
              placeholder={project.name}
            />
            {suggestion && (
              <button
                type="button"
                onClick={() => handleEmojiSelect(suggestion)}
                className="flex items-center gap-2 self-start rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text/70 transition-colors hover:bg-overlay-subtle"
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
