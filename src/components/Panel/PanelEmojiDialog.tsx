import type { RefObject } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { usePanelStore } from "@/store/panelStore";

interface PanelEmojiDialogProps {
  panelId: string;
  /** The panel's title, to say whose emoji this is. */
  title: string;
  isOpen: boolean;
  onClose: () => void;
  /** Where focus goes back to: the menu that opened it is gone by then. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * Gives an agent panel a persona emoji (#16213), shown beside its name in
 * the header, tabs, dock, palettes and notifications. Display only.
 */
export function PanelEmojiDialog({
  panelId,
  title,
  isOpen,
  onClose,
  restoreFocusTo,
}: PanelEmojiDialogProps) {
  const emoji = usePanelStore((s) => s.panelsById[panelId]?.displayEmoji);
  const setDisplayEmoji = usePanelStore((s) => s.setDisplayEmoji);
  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      restoreFocusTo={restoreFocusTo}
      // Opened once the menu had gone, so its opener is nothing to go back to.
      preferRestoreFocusTo
      data-testid="panel-emoji-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Choose an emoji for {title}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="flex justify-center px-6 py-4">
        <EmojiPicker
          className="rounded-[var(--radius-md)] border border-border-default"
          currentEmoji={emoji}
          onEmojiSelect={({ emoji: picked }) => {
            setDisplayEmoji(panelId, picked);
            onClose();
          }}
        />
      </div>
      {emoji && (
        <AppDialog.Footer
          secondaryAction={{
            label: "Clear emoji",
            onClick: () => {
              setDisplayEmoji(panelId, undefined);
              onClose();
            },
          }}
        />
      )}
    </AppDialog>
  );
}
