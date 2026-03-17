/**
 * Prevents Radix Popover from dismissing when the user interacts with elements
 * inside a dock panel rendered via createPortal (which breaks the React context
 * chain that Radix's DismissableLayer relies on for nested floating elements).
 */
export function handleDockInteractOutside(
  event: Event & { preventDefault: () => void },
  portalContainer: HTMLElement | null
) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  // Guard 1: Click originated inside the dock panel's portal container
  if (portalContainer?.contains(target)) {
    event.preventDefault();
    return;
  }

  // Guard 2: Click is on a Radix floating element (DropdownMenu, Tooltip, Select, etc.)
  // portaled to document.body — these carry data-radix-popper-content-wrapper
  if (target.closest("[data-radix-popper-content-wrapper]")) {
    event.preventDefault();
    return;
  }
}
