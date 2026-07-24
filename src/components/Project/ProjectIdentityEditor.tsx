import { useCallback, useEffect, useState } from "react";
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

  // Re-seed when the popover opens, and whenever the project changes underneath
  // it, so a draft left over from another project can never be committed.
  // Deliberately not keyed on `project.name` — that would wipe the field
  // mid-edit as soon as an optimistic rename lands.
  useEffect(() => {
    setDraftName(project.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, project.id]);

  const commitName = useCallback(() => {
    const trimmed = draftName.trim();
    // An emptied field means "no change" rather than "erase the name" — there
    // is no such thing as a nameless project.
    if (!trimmed || trimmed === project.name) {
      setDraftName(project.name);
      return;
    }
    void updateProject(project.id, { name: trimmed });
  }, [draftName, project.id, project.name, updateProject]);

  const handleEmojiSelect = useCallback(
    (picked: string) => {
      if (picked !== project.emoji) {
        void updateProject(project.id, { emoji: picked });
      }
      setIsOpen(false);
    },
    [project.id, project.emoji, updateProject]
  );

  // While a project still carries the default tree, offer the name-derived
  // suggestion as a one-click accept. The tree is the "unset" signal, so the
  // suggestion is shown here rather than silently stored at creation.
  const suggestion =
    project.emoji === DEFAULT_PROJECT_EMOJI ? suggestProjectEmoji(project.name) : null;

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) commitName();
        setIsOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-project-identity-trigger=""
          aria-label={`Edit identity for ${project.name}`}
          className="pointer-events-auto absolute left-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 rounded-[var(--radius-md)] bg-transparent transition-colors hover:bg-overlay-subtle focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align="start"
        data-project-identity-popover=""
        // Hand focus to the name field instead of letting Radix park it on the
        // popover container.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
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
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              id="project-identity-name"
              type="text"
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitName();
                  setIsOpen(false);
                } else if (event.key === "Escape") {
                  // Cancel the edit without letting the keystroke also dismiss
                  // the popover mid-revert.
                  event.preventDefault();
                  event.stopPropagation();
                  setDraftName(project.name);
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
