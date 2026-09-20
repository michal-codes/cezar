# Adaptive admission governor - pressure-aware reduction of the dispatch ceiling

> Slug: `adaptive-admission-governor` · Status: **draft v1, for review** · Brief:
> `.ai/specs/briefs/2026-09-20-adaptive-admission-governor.md` · Consumes: the dispatch cap from
> #1034 (`dispatchMaxConcurrent`) and the effective-capacity measurement from #1042
> (`.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`) · Delivery: one implementation PR
> stacked on those two while they are open.

## 📝 TLDR

The dispatch ceiling becomes a **maximum** instead of a constant. While the process's own cgroup is
under memory or CPU pressure, the governor lowers `dispatchMaxConcurrent` - half at `elevated`, a
quarter at `critical`, never below one child - and lifts the reduction once the machine has been
calm for six samples. It only ever lowers, it never touches a running child, and with no ceiling set
there is nothing to lower: the default path does not change at all. One readout line on
Settings -> Resources shows the state and `effective of configured`.

## 📝 Problem Statement

- **A fixed ceiling cannot know the machine is struggling.** #1034 ships `dispatchMaxConcurrent` as
  an opt-in workspace ceiling and `DISPATCH_MAX_IN_FLIGHT = 4` bounds each parent. Both are static:
  four children on a laptop that is already swapping turn "more parallel work" into "less finished
  work".
- **The measurement exists but nothing consumes it.** #1042 turns host telemetry into effective
  capacity (the process's own cgroup: quota, cpuset, memory limit, cache-excluded usage). It is a
  display. The v2.3 spec pins the governor's chain and stops there on purpose.
- **A governor that cannot be trusted is worse than none.** The failure everyone fears is a cap that
  never lifts, or one that throttles a healthy machine because a file was unreadable. Both are
  structural properties, so this spec fixes them structurally: reduction-only, fail-open,
  hysteresis with a bounded hold, no preemption.

## 📝 Proposed Solution

### 1. The chain, resolved

```
raw pressure (cgroup memory.current/max, memory.events, PSI memory+cpu)
  -> level: normal | elevated | critical        (thresholds + hysteresis below)
  -> reduction factor: 1 | 1/2 | 1/4            (floor 1 child, never 0)
  -> dispatchAdmissionCeiling = ceil(configured * factor)
  -> admission gate: min(dispatchAdmissionCeiling, DISPATCH_MAX_IN_FLIGHT (4), intent.inFlight)
```

`configured` is the user's `dispatchMaxConcurrent`. Ordinary runs never consult this: the gate in
`workflows/run.ts` is deliberately per-candidate and only for `queued.dispatch?.parentRunId`.

### 2. Signals and thresholds (one read per evaluation, no timer)

| Signal | `elevated` | `critical` |
| --- | --- | --- |
| `memory.current / memory.max` (only when `memory.max` is finite) | ≥ 0.85 | ≥ 0.95 |
| `memory.events.high` delta (throttle events) | > 0 since the last sample | - |
| `memory.events.oom_kill` delta | - | > 0 since the last sample (immediate) |
| `memory.pressure` `avg10` | ≥ 20 | ≥ 50 |
| `cpu.pressure` `avg10` | ≥ 80 | - |

Every row is optional: a container without PSI simply contributes nothing, and a machine where
nothing is readable is `normal` (fail-open). The worst reached level wins.

### 3. Hysteresis and the bounded hold

- **Enter**: two consecutive samples at a level (or one `oom_kill`, which is critical at once).
- **Exit**: six consecutive `normal` samples.
- **Hold**: a reduction is held at most `GOVERNOR_MAX_HOLD_MS = 10 min` from the moment it was
  taken; after that the level is re-evaluated on the next look and lifts if the machine is calm.
  A governor that cannot lift is a new cap, and this rule is what forbids it.
- **Cadence**: evaluated lazily, at most once every `GOVERNOR_SAMPLE_INTERVAL_MS = 2 s`, on the
  admission path itself. No interval, no daemon, no cost while nothing dispatches.

### 4. Where the state lives

In the **shared workspace semaphore**, which already owns the workspace-wide counters
(`busy()`, `dispatchBusy()`) and the cached limits: `WorkspaceSemaphore.dispatchAdmissionCeiling()`
answers the effective ceiling, and `admissionState()` answers
`{ state, configured, effective, since }` for the readout. The governor object itself is pure
(input: pressure sample + clock; output: level + factor) and injected, so every rule above is
unit-tested without a cgroup.

### 5. Contract and UI (both additive)

```ts
admission: z.object({
  state: z.enum(['normal', 'elevated', 'critical']),
  configured: z.number().int().positive().optional(),   // the user's ceiling; absent = none set
  effective: z.number().int().positive().optional(),     // what the gate enforces now
  since: z.string().optional(),                          // ISO-8601, when this state began
}).optional()
```

carried on the **existing** `host` topic and `GET /api/v1/workspace/host-usage` payload (no new
route): the sampler reports the semaphore's snapshot. On Settings -> Resources the Machine card
gains one muted line - `Dispatch admission: elevated · 2 of 4` - and the existing
`Max running dispatched tasks` field stays exactly what it is: the ceiling.

## 💥 Edge Cases & Failure Scenarios

| Scenario | Behavior |
| --- | --- |
| No `dispatchMaxConcurrent` set | `normal`, `configured`/`effective` absent: nothing to reduce, default path unchanged. |
| `memory.max = max` (no limit) | The ratio row is skipped; PSI and events still decide. No limit is not "0 % used". |
| No PSI files (older kernel, hardened container) | Those rows are absent; ratio/events decide. |
| No cgroup files at all (non-Linux, no `/proc`) | `normal` - fail-open. |
| `oom_kill` observed | `critical` immediately, no two-sample wait. |
| Pressure clears | Six calm samples then lift; the hold never exceeds 10 min. |
| Ceiling of 1 | Factor applies but the floor is 1: a dispatch child is never starved to zero. |
| Ceiling set lower while reduced | The new `configured` is the base immediately; the effective value is recomputed from it (never higher than the new ceiling). |
| Configured ceiling cleared mid-reduction | `configured = null` ⇒ `normal`, no ceiling - the reduction is dropped with the ceiling, not held. |
| Sampler unreadable / probe throws | The governor's read fails open to `normal`; the admission path never depends on telemetry availability. |
| Two parents fan out at once | `dispatchBusy()` is workspace-wide (from #1034), so the reduced ceiling is shared, not per parent. |
| Restart | The level is in-memory only: a boot is `normal` until pressure says otherwise (a stale reduction must not survive a restart). |

## 🔁 Compatibility

- **Default path**: no ceiling set ⇒ no reduction, no new keys beyond the optional `admission`
  object on a payload consumers already ignore additively. The `host` topic and the route keep
  their shapes.
- **#1034's contract**: `dispatchMaxConcurrent()` keeps answering the CONFIGURED value (its tests
  and the settings route stay true); the new `dispatchAdmissionCeiling()` is the effective one the
  admission gate reads. Splitting the two is what lets the UI say "2 of 4" honestly.
- **No preemption, unchanged**: the gate is per-candidate in `pump()`; a running child is never
  stopped, and ordinary runs are never gated by dispatch admission.
- **BC inventory**: one additive sentence on the existing §2 host-telemetry bullet; no new route,
  no new env var, no state file.

## ✅ Resolved assumptions (draft, for review verification)

| # | Question | Applied answer | Rationale |
| --- | --- | --- | --- |
| A1 | Does adaptive need a knob? | No new setting: the existing `dispatchMaxConcurrent` is the ceiling, and with it unset there is nothing to reduce. | Zero config: the default path must not change. A knob that turns a working default off is a bug, not a feature. |
| A2 | Base for the factor | The user's `configured`; the per-parent `DISPATCH_MAX_IN_FLIGHT` is untouched. | The 4 is an agent-facing contract (how many children a parent may run); lowering it changes the task protocol, which is out of scope. |
| A3 | Reduction shape | `ceil(configured * 1/2)` elevated, `ceil(configured * 1/4)` critical, floor 1. | A ceiling of 4 must mean 2 under pressure - not 3.5, and never 0. |
| A4 | Hysteresis | Enter at 2 samples, exit at 6, `oom_kill` immediate. | Entering late is safer than flapping; exiting slow is safer than flapping. |
| A5 | Max-hold | 10 minutes from the reduction, then re-evaluate. | The failure mode "the cap never lifts" is structural, so the bound is structural. |
| A6 | Pressure source | Raw `memory.current/max`, `memory.events`, PSI - never the cache-excluded display value (F12). | The display value is a rendering artifact; control needs the raw counter. |
| A7 | Where the state lives | The shared workspace semaphore; the sampler only REPORTS it. | One writer, one reader, no telemetry-to-control dependency in the other direction. |
| A8 | Visibility | One readout line on Settings -> Resources, on the payload the page already reads. | The ceiling's owner is the person looking at that page; no new route, no new knob. |
| A9 | Restart | In-memory only, `normal` at boot. | A reduction is a reaction to a live signal; nothing about it is worth persisting. |

## 📋 Deferred (explicitly not in this spec)

- Notifications ("admission reduced because ..."), a history of reductions, and per-project
  governors: the state is visible, not announced.
- Adaptive ceilings for ORDINARY runs (`maxParallel`): the same measurement could inform them, but
  ordinary admission is the workspace's core scheduling promise and changes there deserve their
  own spec.
- Threshold auto-tuning and learned baselines: fixed, documented thresholds first.

## 📋 Phasing

- **Phase 1 - the governor (engine).** Pressure reader + pure state machine + semaphore ceiling +
  the admission gate reading it. Fully unit-tested, no UI.
- **Phase 2 - the readout.** Additive `admission` object on the host payload + the one line in the
  Machine card.

## 📋 Implementation Plan

1. `core/cgroup-pressure.ts`: read the raw signals (reusing `cgroup-probe.ts`'s path resolution
   helpers), injectable file reader, never throws.
2. `core/admission-governor.ts`: the pure state machine - thresholds, hysteresis, max-hold,
   fail-open - with a table-driven test for every row above.
3. Semaphore: `dispatchAdmissionCeiling()` + `admissionState()`; `dispatchMaxConcurrent()` keeps
   answering the configured value. Injected governor and clock for tests.
4. `workflows/run.ts`: the per-candidate gate reads the effective ceiling; tests for "ordinary runs
   unaffected", "one child never starved", "cleared ceiling drops the reduction".
5. Contract + sampler: the additive `admission` object; contract-parity and topic fixtures.
6. Machine card: the readout line plus `docs/reference.md` and the BC §2 sentence.
7. Demo: a script that induces memory pressure in the sandbox container and screenshots the
   readout moving `normal -> elevated -> normal`, with the effective ceiling changing.

