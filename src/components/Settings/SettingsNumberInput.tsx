import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { SettingsInput } from "./SettingsInput";

interface SettingsNumberInputProps extends Omit<ComponentPropsWithoutRef<"input">, "id" | "type"> {
  label: string;
  description?: ReactNode;
  error?: string;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  ref?: Ref<HTMLInputElement>;
}

export function SettingsNumberInput(props: SettingsNumberInputProps) {
  return <SettingsInput type="number" {...props} />;
}
