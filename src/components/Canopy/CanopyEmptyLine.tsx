import type { ReactNode } from "react";

/**
 * What a band or section of the inbox says in place of rows it has none of. Set
 * a step above the labels, in the rows' own rhythm, so it reads as the section's
 * content rather than one more heading over nothing. Quiet on purpose: no glyph
 * and no accent, the same ink for an all-clear as for a caution, so only the
 * words tell a settled conclusion from a qualified one.
 */
export function CanopyEmptyLine({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2.5" data-canopy-empty-line="">
      <p className="text-sm leading-5 text-pretty text-text-secondary">{children}</p>
      {note && <p className="text-xs leading-4 text-text-secondary">{note}</p>}
    </div>
  );
}
