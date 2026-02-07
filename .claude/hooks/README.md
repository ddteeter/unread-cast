# Claude Code Hooks

This directory contains hooks that automatically execute during Claude Code sessions to ensure code quality.

## Available Hooks

### `run-lint.sh`
- **Trigger**: After Edit/Write operations on TypeScript files in `src/`
- **Action**: Runs `eslint --fix` on the modified file
- **Mode**: Synchronous (blocks until complete)
- **Timeout**: 30 seconds

### `run-tests.sh`
- **Trigger**: After Edit/Write operations on TypeScript files in `src/` or `tests/`
- **Action**: Runs full test suite via `npm test`
- **Mode**: Asynchronous (runs in background)
- **Timeout**: 300 seconds (5 minutes)

## How Hooks Work

Hooks are configured in `.claude/settings.json` and execute automatically when Claude Code performs certain actions. They ensure that:

1. Code is automatically linted and formatted after edits
2. Tests run after changes to verify nothing broke
3. Claude receives feedback about failures and can fix them

## Making Changes

To modify hook behavior:

1. Edit the shell scripts in this directory
2. Ensure scripts remain executable: `chmod +x .claude/hooks/*.sh`
3. Test by making a code change in Claude Code
4. Check hook output in Claude's transcript

## Disabling Hooks

To temporarily disable hooks:

1. Edit `.claude/settings.json`
2. Comment out or remove the hook configuration
3. Or set `"enabled": false` on individual hooks

## Troubleshooting

**Hook not running?**
- Verify script is executable: `ls -l .claude/hooks/`
- Check `.claude/settings.json` for correct configuration
- Ensure `jq` is available: `which jq`

**Hook failing?**
- Run the hook manually: `echo '{"tool_input":{"file_path":"src/index.ts"}}' | ./.claude/hooks/run-lint.sh`
- Check npm scripts work: `npm test`, `npm run lint`
- Verify timeout is sufficient for your test suite

## Learn More

See the Claude Code documentation on hooks:
- https://github.com/anthropics/claude-code
- Run `/hooks` in Claude Code for interactive configuration
