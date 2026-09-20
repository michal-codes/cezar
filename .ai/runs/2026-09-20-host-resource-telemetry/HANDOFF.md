# Handoff — 2026-09-20-host-resource-telemetry

**Last updated:** 2026-09-20T00:17:00Z
**Branch:** feat/host-resource-telemetry
**PR:** https://github.com/open-mercato/cezar/pull/1036 (draft)
**Current phase/step:** Phase 1 complete (checkpoint 1); next is Phase 2 Step 2.1
**Last commit:** `feat(server): host WS topic behind the demand-driven subscription bus`

## What just happened
- Steps 1.1–1.5 landed: contract schema, sampler, sampler tests, the workspace route (parity +
  §2 inventory) and the `host` topic. Checkpoint 1: 87 targeted tests + `typecheck:server` green.

## Next concrete action
- Step 2.1: `packages/web/src/api/host-usage.ts` — query key, cache folding, the card-scoped
  subscription, the remote fetch + single warm-up, and the reconcile key in `global-events.tsx`.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: yes (`.ai/scripts/test-env-up.sh`, ~10 s warm)
- Browser / UI checks: enabled (agent-browser; `TMPDIR=/tmp`); not exercised yet (server-only)
- Database/migration state: no migrations involved

## Worktree
- Path: `<repo>/.ai/tmp/om-auto-create-pr/host-resource-telemetry`
- Created this run: yes
