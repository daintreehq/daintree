// Zero-dependency home for the .dntr size cap so eager consumers (IPC
// handlers, download policy) don't pull PluginArchive's yauzl import.
export const MAX_DNTR_BYTES = 30 * 1024 * 1024;

/**
 * Root of a plugin's project-template payloads (#13825): template `<id>` is the
 * folder `project-templates/<id>/`. Shared by the archive packers, which keep
 * the folder's source files and dotfiles intact, and the host, which copies it.
 */
export const PROJECT_TEMPLATES_DIR = "project-templates";
