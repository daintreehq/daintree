/**
 * Built-in panel component registrations.
 * Called once at app startup to register terminal, agent, browser, and notes panels.
 */
import { registerPanelComponent } from "./panelComponentRegistry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { BrowserPane } from "@/components/Browser/BrowserPane";
import { NotesPane } from "@/components/Notes/NotesPane";
import { DevPreviewPane } from "@/components/DevPreview/DevPreviewPane";

// Registration flag to prevent double registration
let registered = false;

/**
 * Register all built-in panel components.
 * Safe to call multiple times - only registers once.
 */
export function registerBuiltInPanelComponents(): void {
  if (registered) return;
  registered = true;

  registerPanelComponent("terminal", { component: TerminalPane }, { allowOverride: true });
  registerPanelComponent("agent", { component: TerminalPane }, { allowOverride: true });
  registerPanelComponent("browser", { component: BrowserPane }, { allowOverride: true });
  registerPanelComponent("notes", { component: NotesPane }, { allowOverride: true });
  registerPanelComponent("dev-preview", { component: DevPreviewPane }, { allowOverride: true });
}
