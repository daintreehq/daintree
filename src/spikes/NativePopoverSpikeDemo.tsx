import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeTooltip } from "@/components/ui/NativeTooltip";
import { NativeDropdown } from "@/components/ui/NativeDropdown";

export function NativePopoverSpikeDemo() {
  const [reduceLocal, setReduceLocal] = useState(false);
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  // Capture the attribute value at mount so we can restore it on unmount —
  // the app-wide setting may already be on, and the demo must not clobber
  // it when the developer-mode gate is toggled off.
  const initialReduceRef = useRef<string | null>(null);

  useEffect(() => {
    initialReduceRef.current = document.body.getAttribute("data-reduce-animations");
    return () => {
      if (initialReduceRef.current === null) {
        document.body.removeAttribute("data-reduce-animations");
      } else {
        document.body.setAttribute("data-reduce-animations", initialReduceRef.current);
      }
    };
  }, []);

  const toggleReduce = () => {
    const next = !reduceLocal;
    setReduceLocal(next);
    if (next) document.body.setAttribute("data-reduce-animations", "true");
    else document.body.removeAttribute("data-reduce-animations");
  };

  const dropdownItems = [
    { id: "rename", label: "Rename", onSelect: () => setLastSelected("Rename") },
    { id: "duplicate", label: "Duplicate", onSelect: () => setLastSelected("Duplicate") },
    { id: "archive", label: "Archive", onSelect: () => setLastSelected("Archive") },
    { id: "delete", label: "Delete", disabled: true, onSelect: () => setLastSelected("Delete") },
  ];

  return (
    <div className="space-y-6 text-xs text-daintree-text">
      <p className="text-daintree-text/70 select-text">
        Native [popover] + CSS Anchor Positioning POC for issue #8992. These surfaces use zero Radix
        code. Verify visually: timing matches tiered motion (tooltip 150/100ms, dropdown 200/120ms),
        tooltips stack across multiple anchors, dropdown flips near viewport edges.
      </p>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={toggleReduce}>
          {reduceLocal ? "Restore animations" : "Toggle reduce-motion"}
        </Button>
        <span className="text-daintree-text/60">
          {reduceLocal ? "body[data-reduce-animations] is set" : "Animations active"}
        </span>
      </div>

      <section className="space-y-3">
        <h5 className="text-xs font-medium text-daintree-text/80">Tooltip — multiple anchors</h5>
        <div className="flex flex-wrap gap-3">
          <NativeTooltip content="Top tooltip" side="top">
            <Button variant="outline" size="sm">
              Hover top
            </Button>
          </NativeTooltip>
          <NativeTooltip content="Right tooltip" side="right">
            <Button variant="outline" size="sm">
              Hover right
            </Button>
          </NativeTooltip>
          <NativeTooltip content="Bottom tooltip" side="bottom">
            <Button variant="outline" size="sm">
              Hover bottom
            </Button>
          </NativeTooltip>
          <NativeTooltip content="Left tooltip" side="left">
            <Button variant="outline" size="sm">
              Hover left
            </Button>
          </NativeTooltip>
        </div>
      </section>

      <section className="space-y-3">
        <h5 className="text-xs font-medium text-daintree-text/80">
          Tooltip — inside transformed ancestor
        </h5>
        <div style={{ transform: "translateZ(0) rotate(0deg)" }} className="inline-block">
          <NativeTooltip content="Anchored from a transformed subtree" side="top">
            <Button variant="outline" size="sm">
              Transformed parent
            </Button>
          </NativeTooltip>
        </div>
        <p className="text-daintree-text/60">
          Top-layer promotion escapes the transform containing block — tooltip should still anchor
          to the trigger.
        </p>
      </section>

      <section className="space-y-3">
        <h5 className="text-xs font-medium text-daintree-text/80">Dropdown — flip near edge</h5>
        <div className="flex justify-between items-center">
          <NativeDropdown
            items={dropdownItems}
            side="bottom"
            align="start"
            triggerClassName="px-3 py-1.5 rounded-md surface-overlay shadow-overlay text-xs"
          >
            Open menu (left)
          </NativeDropdown>
          <NativeDropdown
            items={dropdownItems}
            side="bottom"
            align="end"
            triggerClassName="px-3 py-1.5 rounded-md surface-overlay shadow-overlay text-xs"
          >
            Open menu (right)
          </NativeDropdown>
        </div>
        {lastSelected && <p className="text-daintree-text/60">Last selected: {lastSelected}</p>}
      </section>

      <section className="space-y-2 text-daintree-text/60">
        <h5 className="text-xs font-medium text-daintree-text/80">Parity checks to confirm</h5>
        <ul className="list-disc pl-4 space-y-1">
          <li>Escape closes open dropdown (native CloseWatcher).</li>
          <li>Click-outside on dropdown light-dismisses.</li>
          <li>Reduce-motion toggle suppresses both enter and exit transitions.</li>
          <li>Tooltip exit fade is visible — no instant clip (overlay in transition list).</li>
          <li>Multiple tooltips can be primed simultaneously without state leaks.</li>
        </ul>
      </section>
    </div>
  );
}
