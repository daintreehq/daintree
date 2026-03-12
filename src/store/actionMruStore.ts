import { create } from "zustand";
import { createActionMruSlice, type ActionMruSlice } from "./slices/actionMruSlice";
import { appClient } from "@/clients/appClient";

export const useActionMruStore = create<ActionMruSlice>()((...a) => ({
  ...createActionMruSlice(...a),
}));

let lastPersisted: string[] | null = null;

useActionMruStore.subscribe((state) => {
  const list = state.actionMruList;
  if (list === lastPersisted) return;
  lastPersisted = list;
  void appClient.setState({ actionMruList: list });
});
