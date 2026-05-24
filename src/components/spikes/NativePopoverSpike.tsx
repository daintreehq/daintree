import * as React from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { NativeTooltip } from "./NativeTooltip";
import { NativeDropdown } from "./NativeDropdown";
import "./native-popover-demo.css";

/**
 * DEV-only host for the native `[popover]` spike (#8992). Mounted behind
 * `import.meta.env.DEV` so it never ships. Renders a corner pill that opens an
 * AppDialog containing a native tooltip and a native dropdown — the dialog
 * exercises the Escape-arbitration story: first Escape closes an open menu via
 * the native CloseWatcher, the second closes the dialog.
 */
export default function NativePopoverSpike() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[var(--z-popover)] rounded-full border border-border-default bg-surface-panel px-3 py-1.5 text-xs text-daintree-text/70 shadow-overlay hover:text-daintree-text"
      >
        Popover spike
      </button>
      <AppDialog isOpen={open} onClose={() => setOpen(false)} size="md">
        <AppDialog.Header>
          <AppDialog.Title>Native popover spike</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <p className="text-sm text-daintree-text/70">
                Tooltip — hover or focus the trigger. Positioned with CSS anchor,
                no Floating UI.
              </p>
              <NativeTooltip content="Native [popover=hint] tooltip">
                <button
                  type="button"
                  className="self-start rounded-[var(--radius-md)] border border-border-default px-3 py-1.5 text-sm text-daintree-text"
                >
                  Hover me
                </button>
              </NativeTooltip>
            </section>
            <section className="flex flex-col gap-2">
              <p className="text-sm text-daintree-text/70">
                Dropdown — arrow keys navigate, Enter selects, first Escape closes
                the menu, second Escape closes this dialog.
              </p>
              <NativeDropdown
                label="Open menu"
                triggerClassName="self-start"
                items={[
                  { label: "First action", onSelect: () => {} },
                  { label: "Second action", onSelect: () => {} },
                  { label: "Disabled action", onSelect: () => {}, disabled: true },
                  { label: "Third action", onSelect: () => {} },
                ]}
              />
            </section>
          </div>
        </AppDialog.Body>
      </AppDialog>
    </>
  );
}
