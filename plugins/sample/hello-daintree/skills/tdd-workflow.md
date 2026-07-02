---
description: Step-by-step test-driven development workflow.
applies_to:
  - language: typescript
  - language: javascript
  - language: python
examples:
  - Apply TDD to this feature
  - Write this with test-driven development
---

# TDD Workflow

Follow this sequence for any new feature:

## 1. Red

Write the smallest possible failing test that describes the behavior. Run the test suite — it must fail for the expected reason.

## 2. Green

Write the minimum code needed to make the test pass. Don't refactor yet.

## 3. Refactor

Clean up the code while keeping the test green. Extract helpers, rename for clarity, eliminate duplication.

## When to stop

One feature = one Red-Green-Refactor cycle. Never skip Red — a test that's never seen a failure state isn't a test.
