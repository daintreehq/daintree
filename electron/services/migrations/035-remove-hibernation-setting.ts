import type { Migration } from "../StoreMigrations.js";

/**
 * Drop the retired "Hibernate inactive projects" setting (issue #13840). The
 * switch had done nothing since background hibernation was disabled, so the
 * stored value is no one's choice and must not opt anyone into a future
 * automatic sleep. Deleted whatever it holds, never carried into another key.
 */
export const migration035: Migration = {
  version: 35,
  description: "Remove the retired project hibernation setting (issue #13840)",
  up: (store) => {
    const del = store.delete.bind(store) as (key: string) => void;
    del("hibernation");
  },
};
