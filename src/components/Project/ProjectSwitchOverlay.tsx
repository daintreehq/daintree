export interface ProjectSwitchOverlayProps {
  isSwitching: boolean;
  projectName?: string;
}

export const CANCEL_BUTTON_DELAY_MS = 5_000;

export function ProjectSwitchOverlay(_props: ProjectSwitchOverlayProps) {
  // In multi-view mode each project gets its own WebContentsView,
  // so renderer-side project switching no longer occurs.
  return null;
}
