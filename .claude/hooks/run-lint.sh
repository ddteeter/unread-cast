#!/bin/bash
# .claude/hooks/run-lint.sh
# Auto-run ESLint and Prettier on TypeScript files after edits

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run linter for TypeScript/JavaScript files
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then
  exit 0
fi

# Skip test files and non-src files for faster feedback
if [[ "$FILE_PATH" != src/* && "$FILE_PATH" != tests/* ]]; then
  exit 0
fi

echo "🔍 Running Prettier on $FILE_PATH..."

# Run Prettier first (formatting)
if ! npx prettier --write "$FILE_PATH" 2>&1; then
  echo "⚠️  Prettier formatting failed on $FILE_PATH" >&2
  exit 0  # Don't block, just report
fi

echo "🔍 Running ESLint on $FILE_PATH..."

# Run ESLint (code quality)
if ! npx eslint "$FILE_PATH" --fix 2>&1; then
  echo "⚠️  Linting issues found in $FILE_PATH (attempted auto-fix)" >&2
  exit 0  # Don't block, just report
fi

echo "✓ Formatting and linting passed"
exit 0
