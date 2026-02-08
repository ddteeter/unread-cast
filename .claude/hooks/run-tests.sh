#!/bin/bash
# .claude/hooks/run-tests.sh
# Auto-run tests after code changes

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run tests for TypeScript/JavaScript files
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then
  exit 0
fi

# Skip running tests for non-src/non-test files
if [[ "$FILE_PATH" != src/* && "$FILE_PATH" != tests/* ]]; then
  exit 0
fi

echo "🧪 Running tests..."

# Run all tests (Vitest is fast enough for full suite)
if ! npm test 2>&1; then
  echo "❌ Tests failed after editing $FILE_PATH" >&2
  echo "   Claude should fix the failing tests before proceeding." >&2
  exit 0  # Don't block, but report failure
fi

echo "✓ All tests passed"
exit 0
