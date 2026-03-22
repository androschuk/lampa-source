#!/usr/bin/env bash
# Lists today's slice of repo files for the nightly rolling survey.
#
# Every tracked code/docs file is assigned to one of 28 buckets via a
# deterministic hash of its path. Each day gets one bucket (unix day mod 28),
# so the full repo is surveyed every 28 days.
#
# Output: one file path per line.

set -euo pipefail

CYCLE_LENGTH=28
TODAY_BUCKET=$(( $(date +%s) / 86400 % CYCLE_LENGTH ))

# Files to include for Lampa project
git ls-files -- '*.js' '*.scss' '*.html' '*.json' '*.md' '*.yml' '*.yaml' '*.sh' | while read -r f; do
  # Use cksum if available, otherwise fallback to simple hash for POSIX compatibility
  if command -v cksum >/dev/null 2>&1; then
    hash=$(echo -n "$f" | cksum | awk '{print $1}')
  else
    # Simple fallback using od (should be available on most systems)
    hash=$(echo -n "$f" | od -An -t u4 | awk '{sum += $1} END {print sum}')
  fi
  
  bucket=$(( hash % CYCLE_LENGTH ))
  if [ "$bucket" -eq "$TODAY_BUCKET" ]; then
    echo "$f"
  fi
done
