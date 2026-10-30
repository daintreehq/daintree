import { useEffect, useState } from "react";
import { COMPOSER_GEOMETRY_EVENT } from "../inputEditorExtensions";

export interface EditorScrollEdges {
  above: boolean;
  below: boolean;
}

const NO_EDGES: EditorScrollEdges = { above: false, below: false };

/**
 * Whether a draft taller than the editor's height cap has rows scrolled out of
 * sight above or below the canvas, so the shell can say so: at the cap the
 * first visible row otherwise sits where a first line would, and on macOS the
 * scrollbar is hidden at rest.
 *
 * The shell hears both causes: the editor's own scroll, captured since scroll
 * doesn't bubble, and every layout pass (`COMPOSER_GEOMETRY_EVENT`), so a
 * draft growing into the cap is read in the frame it starts to scroll. The
 * expanded editor reparents out of the canvas and reads as no edges.
 */
export function useEditorScrollEdges(
  inputShellRef: React.RefObject<HTMLDivElement | null>
): EditorScrollEdges {
  const [edges, setEdges] = useState<EditorScrollEdges>(NO_EDGES);

  useEffect(() => {
    const shell = inputShellRef.current;
    if (!shell) return;
    const read = () => {
      const scroller = shell.querySelector<HTMLElement>("[data-composer-canvas] .cm-scroller");
      // Only once the autosize has put the editor in scroll mode at its cap:
      // below the cap a pill a pixel taller than its line can still report a
      // sliver of overflow, and the fade would dim the draft's last row.
      const scrolls = scroller !== null && scroller.style.overflowY === "auto";
      const above = scrolls && scroller.scrollTop > 1;
      const below =
        scrolls && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 1;
      setEdges((current) =>
        current.above === above && current.below === below ? current : { above, below }
      );
    };
    read();
    shell.addEventListener("scroll", read, true);
    shell.addEventListener(COMPOSER_GEOMETRY_EVENT, read);
    return () => {
      shell.removeEventListener("scroll", read, true);
      shell.removeEventListener(COMPOSER_GEOMETRY_EVENT, read);
    };
  }, [inputShellRef]);

  return edges;
}
