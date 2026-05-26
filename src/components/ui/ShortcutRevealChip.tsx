import { useKeybindingDisplay } from "@/hooks";

interface ShortcutRevealChipProps {
  actionId: string;
}

export function ShortcutRevealChip({ actionId }: ShortcutRevealChipProps) {
  const display = useKeybindingDisplay(actionId);
  if (!display) return null;
  return (
    <span aria-hidden="true" className="shortcut-reveal-chip">
      {display}
    </span>
  );
}
