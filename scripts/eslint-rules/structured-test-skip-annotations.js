/**
 * ESLint rule: structured-test-skip-annotations
 *
 * Enforces that every `test.skip()` call in an E2E spec is preceded by a
 * `test.info().annotations.push({ type, description })` in the same block body.
 *
 * Allowed `type` values:
 *   - "quarantine"       — known-flaky test, disabled until root cause is fixed.
 *                          `description` MUST start with YYYY-MM-DD (date quarantined).
 *   - "platform-skip"    — test cannot run on the current OS / browser / CI combo.
 *   - "conditional-skip" — test requires a runtime condition (env var, API key,
 *                          element visibility) that is absent in this launch.
 */

const ALLOWED_TYPES = new Set(["quarantine", "platform-skip", "conditional-skip"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Returns true when `node` is `test.info().annotations.push({ … })`.
 * Accepts the direct-chained form: `test.info().annotations.push(...)`.
 */
function isAnnotationPush(node) {
  if (node.type !== "ExpressionStatement") return false;
  const expr = node.expression;
  if (expr.type !== "CallExpression") return false;

  const callee = expr.callee;
  // test.info().annotations.push(...)
  if (callee.type !== "MemberExpression") return false;
  if (callee.property.type !== "Identifier" || callee.property.name !== "push") return false;

  const obj = callee.object;
  // test.info().annotations
  if (obj.type !== "MemberExpression") return false;
  if (obj.property.type !== "Identifier" || obj.property.name !== "annotations") return false;

  const annotationsObj = obj.object;
  // test.info()
  if (annotationsObj.type !== "CallExpression") return false;
  const infoCallee = annotationsObj.callee;
  if (infoCallee.type !== "MemberExpression") return false;
  if (infoCallee.property.type !== "Identifier" || infoCallee.property.name !== "info") return false;
  if (infoCallee.object.type !== "Identifier" || infoCallee.object.name !== "test") return false;

  return true;
}

/**
 * Extract `type` and `description` from the argument to annotations.push(...).
 * The argument must be an ObjectExpression with at minimum a `type` property.
 */
function extractAnnotation(node) {
  const expr = node.expression;
  const arg = expr.arguments[0];
  if (!arg || arg.type !== "ObjectExpression") return null;

  let typeVal = null;
  let descVal = null;

  for (const prop of arg.properties) {
    if (prop.key.type === "Identifier" && prop.key.name === "type" && prop.value.type === "Literal") {
      typeVal = prop.value.value;
    }
    if (prop.key.type === "Identifier" && prop.key.name === "description" && prop.value.type === "Literal") {
      descVal = prop.value.value;
    }
  }

  if (typeVal === null) return null;
  return { type: typeVal, description: descVal };
}

/**
 * Walk backward through the block body statements before `skipIndex` and
 * collect every annotation-push call.
 */
function findPrecedingAnnotation(body, skipIndex) {
  for (let i = skipIndex - 1; i >= 0; i--) {
    const stmt = body[i];
    if (isAnnotationPush(stmt)) {
      return extractAnnotation(stmt);
    }
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require structured annotations before every test.skip() call",
      recommended: true,
    },
    schema: [],
    messages: {
      missingAnnotation:
        'test.skip() must be preceded by test.info().annotations.push({ type, description }) in the same block.',
      invalidType:
        'Annotation type "{{actual}}" is not valid. Use one of: quarantine, platform-skip, conditional-skip.',
      quarantineMissingDate:
        'Quarantine annotation description must start with YYYY-MM-DD (the date the test was quarantined).',
    },
  },

  create(context) {
    /**
     * Check whether `node` is a `test.skip(...)` call expression.
     */
    function isTestSkip(node) {
      return (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "test" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "skip"
      );
    }

    return {
      CallExpression(node) {
        if (!isTestSkip(node)) return;

        // Find the enclosing block body.
        let blockBody = null;
        let skipIndex = -1;
        let parent = node.parent;

        // Walk up to find the statement that contains this call, then find
        // its containing block.
        while (parent) {
          if (parent.type === "BlockStatement" || parent.type === "Program") {
            blockBody = parent.body;
            // Find the index of the expression statement containing our skip call.
            // node is a CallExpression → parent is ExpressionStatement → in body.
            let stmt = node.parent;
            while (stmt && stmt.parent !== parent) {
              stmt = stmt.parent;
            }
            skipIndex = blockBody.indexOf(stmt);
            break;
          }
          // Descend into block-like structures.
          if (
            parent.type === "BlockStatement" ||
            parent.type === "Program" ||
            parent.type === "FunctionExpression" ||
            parent.type === "ArrowFunctionExpression" ||
            parent.type === "FunctionDeclaration"
          ) {
            // These are the only node types that have a `.body` array of statements.
            // Continue walking up — we need the FIRST one (innermost function/block).
            if (
              parent.type === "BlockStatement" ||
              parent.type === "Program"
            ) {
              blockBody = parent.body;
              let stmt = node.parent;
              while (stmt && stmt.parent !== parent) {
                stmt = stmt.parent;
              }
              skipIndex = blockBody.indexOf(stmt);
              break;
            }
          }
          parent = parent.parent;
        }

        if (!blockBody || skipIndex === -1) return;

        const annotation = findPrecedingAnnotation(blockBody, skipIndex);

        if (!annotation) {
          context.report({
            node,
            messageId: "missingAnnotation",
          });
          return;
        }

        if (!ALLOWED_TYPES.has(annotation.type)) {
          context.report({
            node,
            messageId: "invalidType",
            data: { actual: annotation.type },
          });
        }

        if (annotation.type === "quarantine") {
          if (!annotation.description || !DATE_RE.test(annotation.description)) {
            context.report({
              node,
              messageId: "quarantineMissingDate",
            });
          }
        }
      },
    };
  },
};
