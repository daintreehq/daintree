import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const SCRIM_TRANSITION_MS = 150;

function getDockHeight(): number {
  const dockElement = document.querySelector("[data-dock-density]");
  if (!(dockElement instanceof HTMLElement)) {
    return 0;
  }

  return Math.ceil(dockElement.getBoundingClientRect().height);
}

interface DockPopupScrimProps {
  isOpen: boolean;
}

export function DockPopupScrim({ isOpen }: DockPopupScrimProps) {
  const [isRendered, setIsRendered] = useState(isOpen);
  const [dockHeight, setDockHeight] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      return;
    }

    const timer = window.setTimeout(() => {
      setIsRendered(false);
    }, SCRIM_TRANSITION_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isRendered) {
      return;
    }

    const updateDockHeight = () => {
      setDockHeight(getDockHeight());
    };

    updateDockHeight();

    const dockElement = document.querySelector("[data-dock-density]");
    if (!(dockElement instanceof HTMLElement)) {
      return;
    }

    let resizeObserver: ResizeObserver | null = null;

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateDockHeight);
      resizeObserver.observe(dockElement);
    }

    window.addEventListener("resize", updateDockHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateDockHeight);
    };
  }, [isRendered]);

  if (!isRendered) {
    return null;
  }

  return createPortal(
    <div
      className={cn(
        "fixed top-0 left-0 right-0 pointer-events-none transition-opacity duration-150",
        isOpen ? "opacity-100" : "opacity-0"
      )}
      style={{
        bottom: `${dockHeight}px`,
        zIndex: "var(--z-dock-scrim)",
        background: "rgba(0, 0, 0, 0.45)",
      }}
      aria-hidden="true"
    />,
    document.body
  );
}
