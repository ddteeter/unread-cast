#!/bin/bash
# .claude/hooks/run-docker-check.sh
# Validate Docker build context after modifying Docker-related or build-time dependency files

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run for Docker-related files and build-time dependencies
if [[ "$FILE_PATH" != *"Dockerfile"* && "$FILE_PATH" != *".dockerignore"* && "$FILE_PATH" != *"data/pricing.json.example"* && "$FILE_PATH" != *"package.json"* && "$FILE_PATH" != *"package-lock.json"* ]]; then
  exit 0
fi

echo "🐳 Validating Docker build context for $FILE_PATH..."

# Run full Docker build to validate entire build context and all stages
# This catches issues with excluded files (package-lock.json, migrations/, pricing.json, etc.)
if docker build --quiet -f Dockerfile . > /dev/null 2>&1; then
  echo "✓ Docker build context validation passed"
  exit 0
else
  echo "⚠️  Docker build context validation failed!" >&2
  echo "   This usually means:" >&2
  echo "   - Required files are excluded in .dockerignore" >&2
  echo "   - Dockerfile references files that don't exist" >&2
  echo "   - Build stage dependencies are incorrect" >&2
  echo "" >&2
  echo "   Run 'docker build -f Dockerfile .' to see detailed errors" >&2
  exit 0  # Don't block, just report
fi
