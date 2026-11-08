import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EnvVarRow, type EnvVarDraft } from "@/components/Settings/EnvVarRow";
import { useRowFocus } from "@/components/Settings/useRowFocus";
import { isSecretEnvEntry } from "@/utils/secretDetection";

interface RecipeStepEnvironmentProps {
  /** 1-based, so each step's add action has its own name. */
  step: number;
  rows: readonly EnvVarDraft[];
  /** By row id, from `validateRecipeEnvRows`. */
  errors: Record<string, string>;
  /**
   * A team recipe's values live only on this machine, so an empty one is a
   * value not set here yet rather than one chosen to be empty.
   */
  valuesStayLocal: boolean;
  disabled: boolean;
  onChange: (rows: EnvVarDraft[]) => void;
}

/**
 * A recipe step's environment variables (#16446), in the settings editors' row
 * so a variable reads and validates the same wherever it is set.
 */
export function RecipeStepEnvironment({
  step,
  rows,
  errors,
  valuesStayLocal,
  disabled,
  onChange,
}: RecipeStepEnvironmentProps) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const { register, registerFallback, focusRow, focusAfterDelete } = useRowFocus();

  const addRow = () => {
    const id = `recipe-env-${crypto.randomUUID()}`;
    onChange([...rows, { id, key: "", value: "" }]);
    focusRow(id);
  };

  const deleteRow = (index: number) => {
    const removed = rows[index];
    if (!removed) return;
    focusAfterDelete(
      rows.map((row) => row.id),
      index
    );
    onChange(rows.filter((_, i) => i !== index));
    setRevealed((prev) => {
      if (!prev.has(removed.id)) return prev;
      const next = new Set(prev);
      next.delete(removed.id);
      return next;
    });
  };

  const updateRow = (index: number, field: "key" | "value", value: string) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const toggleReveal = (id: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <EnvVarRow
          key={row.id}
          row={row}
          position={index + 1}
          error={errors[row.id]}
          sensitive={isSecretEnvEntry(row.key, row.value)}
          revealed={revealed.has(row.id)}
          onToggleReveal={() => toggleReveal(row.id)}
          onKeyChange={(value) => updateRow(index, "key", value)}
          onValueChange={(value) => updateRow(index, "value", value)}
          onDelete={() => deleteRow(index)}
          valuePlaceholder={valuesStayLocal ? "Not set on this machine" : undefined}
          keyRef={register(row.id)}
          disabled={disabled}
          className="p-0"
        />
      ))}
      <Button
        ref={registerFallback}
        variant="outline"
        size="sm"
        onClick={addRow}
        disabled={disabled}
        aria-label={`Add variable to terminal ${step}`}
      >
        <Plus />
        Add variable
      </Button>
    </div>
  );
}
