/**
 * Utilities for prompt template variable substitution.
 * Supports {variableName} syntax for dynamic value injection.
 */

/**
 * Extract all variable names from a prompt template.
 * Variables are defined using {variableName} syntax.
 *
 * @param template The prompt template string
 * @returns Array of unique variable names found in the template
 */
export function extractTemplateVariables(template: string): string[] {
  const pattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const variables = new Set<string>();
  let match;

  while ((match = pattern.exec(template)) !== null) {
    variables.add(match[1]!);
  }

  return Array.from(variables);
}

/**
 * Result of template validation.
 */
export interface TemplateValidationResult {
  /** Whether the template is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** List of invalid variable references */
  invalidVariables?: string[];
  /** List of all variables found in the template */
  foundVariables: string[];
}

/**
 * Validate a prompt template against available argument names.
 *
 * @param template The prompt template string
 * @param availableArgs Array of valid argument names
 * @returns Validation result with details about any issues
 */
export function validatePromptTemplate(
  template: string,
  availableArgs: string[]
): TemplateValidationResult {
  const foundVariables = extractTemplateVariables(template);
  const availableSet = new Set(availableArgs);
  const invalidVariables = foundVariables.filter((v) => !availableSet.has(v));

  if (invalidVariables.length > 0) {
    return {
      valid: false,
      error: `Unknown variable(s): ${invalidVariables.map((v) => `{${v}}`).join(", ")}`,
      invalidVariables,
      foundVariables,
    };
  }

  return {
    valid: true,
    foundVariables,
  };
}

/**
 * Result of template substitution.
 */
export interface TemplateSubstitutionResult {
  /** Whether substitution succeeded */
  success: boolean;
  /** The resulting prompt with variables substituted */
  prompt?: string;
  /** Error message if substitution failed */
  error?: string;
  /** Variables that were missing values */
  missingVariables?: string[];
}

/**
 * Substitute variables in a prompt template with provided values.
 * Returns an error if any referenced variables are missing values.
 *
 * @param template The prompt template string
 * @param values Object mapping variable names to their values
 * @returns Substitution result with the final prompt or error details
 */
export function substituteTemplateVariables(
  template: string,
  values: Record<string, unknown>
): TemplateSubstitutionResult {
  const variables = extractTemplateVariables(template);
  const missingVariables: string[] = [];

  // Check for missing values (using hasOwnProperty to avoid prototype pollution)
  for (const variable of variables) {
    if (
      !Object.prototype.hasOwnProperty.call(values, variable) ||
      values[variable] === undefined ||
      values[variable] === null
    ) {
      missingVariables.push(variable);
    }
  }

  if (missingVariables.length > 0) {
    return {
      success: false,
      error: `Missing value(s) for: ${missingVariables.map((v) => `{${v}}`).join(", ")}`,
      missingVariables,
    };
  }

  // Perform substitution
  const prompt = template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, varName: string) => {
    const value = values[varName];
    return String(value);
  });

  return {
    success: true,
    prompt,
  };
}
