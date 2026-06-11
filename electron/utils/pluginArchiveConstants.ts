// Zero-dependency home for the .dntr size cap so eager consumers (IPC
// handlers, download policy) don't pull PluginArchive's yauzl import.
export const MAX_DNTR_BYTES = 30 * 1024 * 1024;
