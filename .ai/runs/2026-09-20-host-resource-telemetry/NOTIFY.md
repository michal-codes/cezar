# Notify — 2026-09-20-host-resource-telemetry

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-09-20T00:15:00Z — run started
- Brief: implement `.ai/specs/2026-09-20-host-resource-telemetry.md` (spec PR #1035, v2.1) — live
  host CPU/RAM/swap/load in a Machine card in Settings → Resources, WS topic `host` +
  `GET /api/v1/workspace/host-usage`.
- External skill URLs: none.

## 2026-09-20T00:17:00Z — checkpoint 1 (Phase 1 complete)
- Steps 1.1–1.5 done; targeted validation 87 tests + `typecheck:server`/`typecheck:contract` green.
- UI pass skipped with reason: server-only Steps, no screen changed yet.
- PR #1036 is open as a draft and claimed by comment (label/assignee writes are refused, 403).
