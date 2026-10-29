/** A plugin panel one view says holds unsaved work, as that view reports it (#15031). */
export interface PluginUnsavedPanelReport {
  panelId: string;
  /** The panel kind's `extensionId`: an installed plugin's id or a project instance key. */
  pluginId: string;
  title: string;
}

/** A panel whose unsaved work disabling, updating or uninstalling its plugin discards. */
export interface PluginUnsavedPanel {
  panelId: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
}
