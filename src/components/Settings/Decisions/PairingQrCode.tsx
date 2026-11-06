import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** ISO/IEC 18004 asks for four modules of light margin on every side. */
const QUIET_ZONE = 4;
/**
 * Whole CSS pixels per module keep its edges sharp. Three is the floor: a
 * pairing link is a version 15 code at level L, so anything smaller is a
 * dense field a phone held at arm's length struggles to lock onto.
 */
const MIN_PX_PER_MODULE = 3;
const TARGET_PX = 256;

interface Encoded {
  size: number;
  path: string;
}

/** One path for every dark module, so the SVG stays a single node however large the code. */
function toPath(data: boolean[][]): string {
  let d = "";
  data.forEach((row, y) => {
    let run = -1;
    for (let x = 0; x <= row.length; x++) {
      const dark = x < row.length && row[x];
      if (dark && run < 0) run = x;
      if (!dark && run >= 0) {
        d += `M${run + QUIET_ZONE} ${y + QUIET_ZONE}h${x - run}v1h${run - x}z`;
        run = -1;
      }
    }
  });
  return d;
}

/**
 * The pairing link as a QR code (#16009). The encoder is imported here, on
 * first use, so it is its own chunk: nothing loads it until a pairing starts.
 *
 * Always dark modules on white with the full quiet zone, in every theme:
 * many phone scanners only read that polarity, so this tile is a scanning
 * surface rather than themed chrome.
 */
export function PairingQrCode({ value, className }: { value: string; className?: string }) {
  const [encoded, setEncoded] = useState<{ value: string; qr: Encoded } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    import("uqr").then(
      ({ encode }) => {
        if (!active) return;
        // L: a screen is a clean surface, and the lowest correction level
        // keeps the version down and the modules large.
        const qr = encode(value, { ecc: "L", border: 0 });
        setEncoded({ value, qr: { size: qr.size, path: toPath(qr.data) } });
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [value]);

  const qr = encoded?.value === value ? encoded.qr : null;
  const modules = (qr?.size ?? 0) + QUIET_ZONE * 2;
  const pxPerModule = qr ? Math.max(MIN_PX_PER_MODULE, Math.floor(TARGET_PX / modules)) : 0;
  const px = qr ? modules * pxPerModule : TARGET_PX;

  if (failed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-default bg-surface-input p-6",
          className
        )}
        style={{ width: px, height: px }}
      >
        <p className="text-center text-xs text-text-secondary">
          The QR code couldn&apos;t be drawn. Open the link below on your phone instead.
        </p>
      </div>
    );
  }

  // The quiet zone is inside the SVG; the tile's own padding, rounding and
  // outline sit outside it, so nothing is ever drawn over those four modules.
  return (
    <div
      className={cn(
        "shrink-0 rounded-[var(--radius-md)] bg-white p-2",
        // Keeps the tile's edge where the white meets a light card.
        "outline outline-1 outline-border-default",
        className
      )}
      data-pairing-qr=""
    >
      <div style={{ width: px, height: px }}>
        {qr && (
          <svg
            role="img"
            aria-label="QR code holding the pairing link, which is also shown as text"
            width={px}
            height={px}
            viewBox={`0 0 ${modules} ${modules}`}
            shapeRendering="crispEdges"
          >
            <path d={qr.path} fill="#000" />
          </svg>
        )}
      </div>
    </div>
  );
}
