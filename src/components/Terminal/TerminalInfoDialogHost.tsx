import { useEffect, useState } from "react";
import { TerminalInfoDialog } from "./TerminalInfoDialog";

export function TerminalInfoDialogHost() {
  const [isOpen, setIsOpen] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      const id = typeof (detail as { id?: unknown })?.id === "string" ? (detail as any).id : null;
      if (!id) return;
      setTerminalId(id);
      setIsOpen(true);
    };

    const controller = new AbortController();
    window.addEventListener("canopy:open-terminal-info", handleOpen, { signal: controller.signal });
    return () => controller.abort();
  }, []);

  return (
    <TerminalInfoDialog
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      terminalId={terminalId ?? ""}
    />
  );
}
