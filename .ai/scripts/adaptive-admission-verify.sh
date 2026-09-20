#!/bin/sh
# Adaptive admission governor - one-command verification, runnable from ANY cezar checkout.
#
# Why this exists: `npx vitest run ... -t dispatch` skips EVERYTHING in a checkout that predates
# #1034 and this feature (vitest's -t is a name filter, and those checkouts have no test whose name
# contains "dispatch"), which reads like "the feature does nothing". This script checks for the
# modules, fetches the branch into a throwaway worktree when they are missing, and runs the suites
# that actually pin the behaviour.
#
# Usage:  sh .ai/scripts/adaptive-admission-verify.sh
# Env:    CEZ_ADAPTIVE_BRANCH (default feat/adaptive-admission-governor)
#         CEZ_ADAPTIVE_FORK   (default https://github.com/michal-codes/cezar.git)
#         CEZ_ADAPTIVE_WORKTREE (default /tmp/cez-adaptive-verify)
set -eu

say() { printf '%s\n' "$*"; }

BRANCH=${CEZ_ADAPTIVE_BRANCH:-feat/adaptive-admission-governor}
FORK_URL=${CEZ_ADAPTIVE_FORK:-https://github.com/michal-codes/cezar.git}
TMP_WORKTREE=${CEZ_ADAPTIVE_WORKTREE:-/tmp/cez-adaptive-verify}

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"
say "checkout: $REPO_ROOT"
say "branch:   $(git branch --show-current 2>/dev/null || echo '(detached)') @ $(git log --oneline -1)"

if [ ! -f packages/cezar/src/core/admission-governor.ts ]; then
  say "governor modules: ABSENT here - that is exactly why '-t dispatch' shows only skips"
  say "fetching $BRANCH into $TMP_WORKTREE ..."
  git fetch "$FORK_URL" "$BRANCH" >/dev/null 2>&1
  if [ -e "$TMP_WORKTREE/.git" ]; then
    git worktree remove --force "$TMP_WORKTREE"
  fi
  git worktree add --detach "$TMP_WORKTREE" FETCH_HEAD >/dev/null
  cd "$TMP_WORKTREE"
  say "installing dependencies there (npm ci) ..."
  npm ci --no-audit --no-fund >/dev/null 2>&1
  say "(remove it later with: git worktree remove --force $TMP_WORKTREE)"
else
  say "governor modules: present - verifying THIS checkout"
fi

say ""
say "== the dispatch gate: a child waits, an ordinary run passes it"
npx vitest run packages/cezar/src/workflows/workspace-semaphore.test.ts -t "dispatch"

say ""
say "== the governor's own rule: the reduced ceiling holds, and lifts without a restart"
npx vitest run packages/cezar/src/workflows/workspace-semaphore.test.ts -t "reduced"

say ""
say "== the policy suites: thresholds, streaks, clock-bounded hold, PSI parsing, fail-open"
npx vitest run packages/cezar/src/core/admission-governor.test.ts packages/cezar/src/core/cgroup-pressure.test.ts

say ""
say "== live demo (needs a container built from this branch, see the PR body)"
say "   sh .ai/scripts/adaptive-admission-demo.sh http://127.0.0.1:4400 cez-adaptive-demo"
