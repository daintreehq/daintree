import { useEffect, useState } from "react";
import { TerminalInfoDialog } from "./TerminalInfoDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export function TerminalInfoDialogHost() {
  const [isOpen, setIsOpen] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  // Monotonic open counter — `Number(isOpen)` would stay `[1]` across repeated
  // opens while the dialog is already open, so a crashed boundary would never
  // reset on the next open. The counter changes on every open event (#9918).
  const [openSeq, setOpenSeq] = useState(0);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      const id = typeof (detail as { id?: unknown })?.id === "string" ? (detail as any).id : null;
      if (!id) return;
      setTerminalId(id);
      setIsOpen(true);
      setOpenSeq((s) => s + 1);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:open-terminal-info", handleOpen, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  return (
    <ErrorBoundary variant="component" componentName="TerminalInfoDialog" resetKeys={[openSeq]}>
      <TerminalInfoDialog
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        terminalId={terminalId ?? ""}
      />
    </ErrorBoundary>
  );
}
