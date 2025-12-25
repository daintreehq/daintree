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

  // Terminal panel - plain terminal sessions
  registerPanelComponent("terminal", {
    component: TerminalPane,
  });

  // Agent panel - AI agent sessions (Claude, Gemini, etc.)
  // Uses same component as terminal, distinguished by agentId prop
  registerPanelComponent("agent", {
    component: TerminalPane,
  });

  // Browser panel - localhost iframe browser
  registerPanelComponent("browser", {
    component: BrowserPane,
  });

  // Notes panel - Markdown note editor
  registerPanelComponent("notes", {
    component: NotesPane,
  });

  // Dev Preview panel - auto-starts dev server and shows iframe
  registerPanelComponent("dev-preview", {
    component: DevPreviewPane,
  });
}
