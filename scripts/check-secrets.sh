#!/usr/bin/env sh
# Fail if a Stellar secret seed (S + 55 base32 chars) is present in any tracked file.
set -eu
if git grep -nE '\bS[A-Z2-7]{55}\b' -- ':!scripts/check-secrets.sh' ; then
  echo "Stellar secret seed found in tracked files. Remove it and rotate the key." >&2
  exit 1
fi
echo "no secrets found"
