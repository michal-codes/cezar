import { useEffect, useState } from 'react'

import { useHostTransport, useHostUsage, useHostUsageSubscription } from '@/api/host-usage'
import { StatusDot } from '@/components/status-dot'
import { formatMem } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

/**
 * The Machine card — live host totals at the top of Settings → Resources (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`).
 *
 * It is the ONLY consumer of the `host` topic, and it subscribes from its own view effect, so
 * leaving this screen is what stops the server's sampler (0→1 / 1→0). A remote cockpit never
 * opens a socket — the hook reads `GET /api/v1/workspace/host-usage` instead, and its answer is
 * labelled `last known`.
 *
 * The 60 s sparkline lives in COMPONENT state on purpose: it restarts when the card unmounts.
 * The freshness line is receipt time, recomputed when a frame or a query result arrives — there
 * is no ticking clock in here, and none is needed: a live sampler pushes every 2 s.
 */

/** 30 frames × the server's 2 s cadence = the 60 s line. */
const HISTORY_LENGTH = 30
const SPARK_WIDTH = 100
const SPARK_HEIGHT = 32
/** Where the CPU bar changes colour: quiet below 60 %, amber to 85 %, red above. */
const CPU_WARN_PCT = 60
const CPU_DANGER_PCT = 85

const clampPct = (value: number): number => Math.min(100, Math.max(0, value))

export function MachineCard() {
  useHostUsageSubscription()
  const transport = useHostTransport()
  const { data: sample, isError } = useHostUsage()

  const [history, setHistory] = useState<number[]>([])
  const [receivedAt, setReceivedAt] = useState<number | null>(null)

  const cpuPct = sample?.cpuPct
  useEffect(() => {
    if (sample === undefined) return
    setReceivedAt(Date.now())
    if (cpuPct === undefined) return
    setHistory((previous) => [...previous, cpuPct].slice(-HISTORY_LENGTH))
  }, [sample, cpuPct])

  const local = transport === 'local'
  const ageSeconds =
    receivedAt === null ? undefined : Math.max(0, Math.round((Date.now() - receivedAt) / 1000))
  const usedPct =
    sample !== undefined && sample.memTotalBytes > 0
      ? clampPct((sample.memUsedBytes / sample.memTotalBytes) * 100)
      : 0
  const cpuFill =
    cpuPct === undefined
      ? undefined
      : cpuPct > CPU_DANGER_PCT
        ? 'bg-danger'
        : cpuPct >= CPU_WARN_PCT
          ? 'bg-pending'
          : 'bg-primary'
  const cpuFillPct = cpuPct === undefined ? undefined : clampPct(cpuPct)
  const points =
    history.length >= 2
      ? history
          .map((value, index) => {
            const x = (index / (HISTORY_LENGTH - 1)) * SPARK_WIDTH
            const y = SPARK_HEIGHT - (clampPct(value) / 100) * SPARK_HEIGHT
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
      : undefined

  return (
    <section
      data-slot="machine-card"
      aria-labelledby="machine-card-title"
      className="rounded-xl border border-border bg-card/60 p-4"
    >
      <header className="flex min-w-0 items-center gap-2">
        <StatusDot tone={local ? 'success' : 'neutral'} pulse={local} />
        <h2 id="machine-card-title" className="text-sm font-semibold">
          Machine
        </h2>
        <span data-slot="machine-card-mode" className="text-[11px] text-soft-foreground">
          {local ? 'live' : 'last known'}
        </span>
        <span
          data-slot="machine-card-freshness"
          className="ml-auto shrink-0 text-[11px] tabular-nums text-soft-foreground"
        >
          {ageSeconds === undefined ? 'waiting…' : `updated ${ageSeconds} s ago`}
        </span>
      </header>

      {isError && sample === undefined ? (
        <p data-slot="machine-card-error" className="mt-3 text-[12.5px] text-soft-foreground">
          Host totals are unavailable right now.
        </p>
      ) : null}

      <div className="mt-3 grid gap-3">
        <div data-slot="machine-card-cpu" className="grid grid-cols-[86px_1fr] items-start gap-3">
          <span className="pt-0.5 text-[12.5px] text-soft-foreground">CPU</span>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                data-slot="machine-card-cpu-value"
                className="w-14 shrink-0 text-[13px] tabular-nums"
              >
                {cpuPct === undefined ? 'sampling…' : `${Math.round(cpuPct)}%`}
              </span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                {cpuFill === undefined || cpuFillPct === undefined ? null : (
                  <div
                    data-slot="machine-card-cpu-bar"
                    className={cn('h-full rounded-full', cpuFill)}
                    style={{ width: `${cpuFillPct}%` }}
                  />
                )}
              </div>
            </div>
            {points === undefined ? null : (
              <svg
                data-slot="machine-card-cpu-sparkline"
                className="mt-1.5 h-8 w-full text-primary"
                viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`CPU over the last ${history.length * 2} seconds`}
              >
                <polyline
                  points={points}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        </div>

        {sample === undefined ? null : (
          <>
            <div
              data-slot="machine-card-memory"
              className="grid grid-cols-[86px_1fr] items-center gap-3"
            >
              <span className="text-[12.5px] text-soft-foreground">Memory</span>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  data-slot="machine-card-memory-value"
                  className="w-32 shrink-0 text-[13px] tabular-nums"
                >
                  {formatMem(sample.memUsedBytes)} / {formatMem(sample.memTotalBytes)}
                </span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
                </div>
              </div>
            </div>

            {sample.swapTotalBytes === undefined ? null : (
              <div
                data-slot="machine-card-swap"
                className="grid grid-cols-[86px_1fr] items-center gap-3"
              >
                <span className="text-[12.5px] text-soft-foreground">Swap</span>
                <span className="text-[13px] tabular-nums">
                  {formatMem(sample.swapUsedBytes)} / {formatMem(sample.swapTotalBytes)}
                </span>
              </div>
            )}

            {sample.loadAvg === undefined ? null : (
              <div
                data-slot="machine-card-load"
                className="grid grid-cols-[86px_1fr] items-center gap-3"
              >
                <span className="text-[12.5px] text-soft-foreground">Load average</span>
                <span className="flex items-center gap-2 text-[13px] tabular-nums">
                  {sample.loadAvg.one.toFixed(2)} · {sample.loadAvg.five.toFixed(2)} ·{' '}
                  {sample.loadAvg.fifteen.toFixed(2)}
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-soft-foreground">
                    {sample.cpuCount} cores
                  </span>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <p
        data-slot="machine-card-caveat"
        className="mt-3 border-t border-border pt-2 text-[11px] text-soft-foreground"
      >
        Host totals — container/cgroup limits are not subtracted.
      </p>
    </section>
  )
}
