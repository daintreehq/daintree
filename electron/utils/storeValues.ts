interface RawStoreWriter {
  set(key: string, value: unknown): void;
}

/**
 * Migrations, recovery and version-tolerant records preserve data that doesn't
 * conform to this build's schema. Use conf's dynamic-key write overload for
 * those writes; ordinary settings continue using its typed overloads.
 */
export function setRawStoreValue(store: RawStoreWriter, key: string, value: unknown): void {
  store.set(key, value);
}
