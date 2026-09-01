#!/bin/bash
# Fails if any tracked source or doc contains an em/en dash or an AI-attribution
# line. Zero dependencies so it runs the same locally and in CI. Deeper prose
# scanning is a local pre-push step with the humanizer; this is the hard floor.
set -uo pipefail
cd "$(dirname "$0")/.."

# This script is excluded from its own scan: its patterns necessarily contain
# the very strings it searches for, which would otherwise self-flag.
# Untracked-but-not-ignored files are scanned too, so a fresh file fails the
# local run the same way it would fail CI once staged.
globs=('*.js' '*.mjs' '*.css' '*.html' '*.md' '*.py' '*.sh' '*.json' '*.toml'
  ':!:app/vendor/**' ':!:tools/check-clean.sh')
files=$( (git ls-files -- "${globs[@]}"; git ls-files --others --exclude-standard -- "${globs[@]}") | sort -u )

fail=0

dash=$(printf '%s\n' "$files" | xargs -r grep -lP '\x{2013}|\x{2014}' 2>/dev/null || true)
if [ -n "$dash" ]; then
  echo "em/en dash found in:"; printf '  %s\n' $dash; fail=1
fi

attr=$(printf '%s\n' "$files" | xargs -r grep -liE 'co-authored-by|generated with (claude|ai)|🤖' 2>/dev/null || true)
if [ -n "$attr" ]; then
  echo "AI attribution found in:"; printf '  %s\n' $attr; fail=1
fi

if [ "$fail" -eq 0 ]; then echo "clean: no em/en dashes, no AI attribution"; fi
exit $fail
