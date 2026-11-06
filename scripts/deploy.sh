#!/usr/bin/env bash
# Runs the test suite, then deploys to the given target - refuses to touch
# lodge-qa.appdoivo.com or lodge.appdoivo.com if a test fails.
# See CONTRIBUTING.md for the full branch -> QA -> prod process this fits into.
#
# Auth: one token per environment, picked by target, so the credential that
# deploys QA cannot reach production at all. That is the whole point of
# splitting them - a single account-wide token means any accident or leak
# reaches everything. FLY_API_TOKEN is still honoured as a fallback for
# anywhere that sets one directly (CI, a one-off shell), so nothing that
# worked before stops working.
set -euo pipefail

target="${1:-}"
if [[ "$target" != "qa" && "$target" != "prod" && "$target" != "demo" ]]; then
  echo "Usage: scripts/deploy.sh <qa|prod|demo>" >&2
  exit 1
fi

# Reads one variable out of .env without sourcing the file - .env holds
# secrets with characters a shell would happily interpret. Sourcing it is
# not a shortcut worth taking: an unquoted Fly token run through `source`
# fails with the token itself in the error message, which is how both of
# them ended up in a transcript on 2026-08-11.
#
# Surrounding quotes are stripped, so writing them into .env quoted - the
# only way to make that `source` accident harmless - does not hand the
# quotes to Fly as part of the credential.
read_env() {
  local value
  [[ -f .env ]] || return 0
  value="$(grep -m1 "^$1=" .env | cut -d= -f2-)"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

if [[ "$target" == "qa" ]]; then
  token="${FLY_API_TOKEN_QA:-$(read_env FLY_API_TOKEN_QA)}"
elif [[ "$target" == "demo" ]]; then
  token="${FLY_API_TOKEN_DEMO:-$(read_env FLY_API_TOKEN_DEMO)}"
else
  token="${FLY_API_TOKEN_PROD:-$(read_env FLY_API_TOKEN_PROD)}"
fi
# Fallback: the older single token, for CI and anything not yet split.
token="${token:-${FLY_API_TOKEN:-$(read_env FLY_API_TOKEN)}}"

if [[ -z "$token" ]]; then
  echo "No Fly token for '$target'. Set FLY_API_TOKEN_${target^^} in .env (see CONTRIBUTING.md)." >&2
  exit 1
fi
export FLY_API_TOKEN="$token"

echo "Running tests before deploy..."
npm test

if [[ "$target" == "qa" ]]; then
  fly deploy -a appdoivo-qa --config fly.qa.toml
elif [[ "$target" == "demo" ]]; then
  fly deploy -a appdoivo-demo --config fly.demo.toml
else
  fly deploy -a appdoivo
fi
