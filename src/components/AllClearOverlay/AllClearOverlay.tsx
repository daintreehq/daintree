import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const FLASH_DURATION_MS = 450;

export function AllClearOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const cleanup = window.electron.terminal.onAllAgentsClear(() => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (document.body.getAttribute("data-performance-mode") === "true") return;

      setVisible(true);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 pointer-events-none z-[200] animate-all-clear-flash bg-status-success"
      aria-hidden="true"
    />,
    document.body
  );
}
