import { ChevronRightIcon, GitMergeIcon, TerminalIcon } from 'lucide-react'
import { Fragment, useState } from 'react'

import { useRuns } from '@/api/queries'
import type { ApiRun, LandingCheck, RunEvent } from '@open-mercato/cezar-api-client'
import { LandingCheckChip } from '@/components/landing-check-chip'
import { StatusDot } from '@/components/status-dot'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  humanizeLandingReason,
  landingCheckChip,
  landingCheckNotRun,
  landingCheckRows,
  landingSubjectFacts,
  shortSha,
  type LandingCheckRow,
} from '@/lib/landing-check'
import { Link } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'

import { ToolOutput } from './thread-items'

/**
 * The landing check's card, on the CHECK run's own thread (spec
 * `.ai/specs/2026-09-29-landing-check.md` § UI/UX, PR 5).
 *
 * The check run is an ordinary run — its step rail, its transcript and its `check-output` cards
 * all work untouched. What this card adds is the one thing the transcript cannot say at a
 * glance: what combination was checked (the frozen subject), what the verdict was, and why a
 * `nothing-to-check` or a `could-not-run` is not a pass.
 *
 * Two renderings are load-bearing and both follow from how the record is written:
 *
 *  - **The two-stage empty state.** The subject is persisted before the first merge, commands
 *    and verdict after materialization — so a subject-only record is normal and must read as
 *    "freezing", then "merging", never as an error or a fake set of rows.
 *  - **Neutral for `nothing-to-check` / `could-not-run`.** Nothing green is ever painted for a
 *    check that did not pass, and nothing red for one that never had a chance to run.
 */
export function LandingCheckCard({ run, events = [] }: { run: ApiRun; events?: readonly RunEvent[] }) {
  const check = run.landingCheck
  if (check === undefined) return null
  const chip = landingCheckChip({ landingCheck: check, landingCheckStale: run.landingCheckStale, status: run.status })
  const facts = landingSubjectFacts(check)
  const rows = landingCheckRows(check, events)
  const notRun = landingCheckNotRun(run)

  return (
    <section data-slot="landing-check-card" data-state={chip?.state} aria-label="Landing check">
      <div
        className={cn(
          'min-w-0 overflow-hidden rounded-md border bg-card',
          chip?.tone === 'success' ? 'border-success/30' : chip?.tone === 'danger' ? 'border-danger/25' : 'border-border',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
          <GitMergeIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Landing check</span>
          {chip !== undefined ? <LandingCheckChip landingCheck={check} stale={run.landingCheckStale === true} status={run.status} marker={false} /> : null}
          {chip?.stale ? (
            <span data-slot="landing-check-stale" className="text-[11px] font-medium text-pending-strong">
              stale
            </span>
          ) : null}
          <InvokedForLine ofRunId={check.ofRunId} />
        </div>

        <div className="flex flex-col gap-2 px-3 py-2.5">
          <SubjectLine facts={facts} />
          {facts.excluded.length > 0 ? (
            <p data-slot="landing-check-excluded" className="text-[11.5px] text-soft-foreground">
              Excluded from the subject: {facts.excluded.join(', ')}
            </p>
          ) : null}
          {check.reason !== undefined && check.verdict !== 'passed' ? (
            <p data-slot="landing-check-reason" className="text-xs text-muted-foreground">
              {humanizeLandingReason(check.reason)}
            </p>
          ) : null}

          {check.preview !== undefined ? (
            <div data-slot="landing-check-preview" className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11.5px] text-muted-foreground">
              <p className="font-semibold text-foreground">Preview — nothing was executed</p>
              <p className="mt-0.5">
                {check.preview.authors.length > 0 ? `authors ${check.preview.authors.join(', ')} · ` : ''}
                head <code className="font-mono">{shortSha(check.preview.headSha) ?? check.preview.headSha}</code>
                {check.preview.diffStat !== undefined ? ` · ${check.preview.diffStat}` : ''}
              </p>
              {check.preview.commands.length > 0 ? (
                <p className="mt-0.5 font-mono">{check.preview.commands.join(' · ')}</p>
              ) : null}
              <p className="mt-1">A foreign subject needs an acknowledgement before it can run — not available in the cockpit yet.</p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div data-slot="landing-check-rows" className="flex flex-col gap-1.5">
              {rows.map((row) => (
                <LandingCheckRowCard key={row.id} row={row} />
              ))}
            </div>
          ) : check.verdict === undefined ? (
            <StageTrail check={check} live={['queued', 'running', 'waiting'].includes(run.status)} />
          ) : (
            <p data-slot="landing-check-empty" className="text-xs text-muted-foreground">
              {emptyVerdictNote(check)}
            </p>
          )}

          {notRun > 0 ? (
            <p data-slot="landing-check-not-run" className="text-[11.5px] text-soft-foreground">
              {notRun === 1 ? '1 more command did not run.' : `${notRun} more commands did not run.`}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

/** "for <parent task>" — the check run is always about exactly one invoking run. */
function InvokedForLine({ ofRunId }: { ofRunId: string }) {
  const runs = useRuns()
  const parent = (runs.data ?? []).find((candidate) => candidate.id === ofRunId)
  return (
    <span className="min-w-0 truncate text-xs text-muted-foreground">
      for{' '}
      <Link
        to={`/tasks/${ofRunId}`}
        data-slot="landing-check-invoking-run"
        data-run-id={ofRunId}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {parent !== undefined ? runTitle(parent) : ofRunId}
      </Link>
    </span>
  )
}

/** Base · sources · tree — one line, every value the record pinned. */
function SubjectLine({ facts }: { facts: ReturnType<typeof landingSubjectFacts> }) {
  const parts = [
    <Fragment key="base">
      base <code className="font-mono text-[11.5px]">{facts.baseRef}</code> @{' '}
      <code className="font-mono text-[11.5px]">{shortSha(facts.baseSha) ?? facts.baseSha}</code>
    </Fragment>,
    <span key="sources">
      {facts.sourceCount === 0
        ? 'no eligible sources — the base alone'
        : `${facts.sourceCount} source${facts.sourceCount === 1 ? '' : 's'} merged`}
    </span>,
  ]
  if (facts.treeSha !== undefined) {
    parts.push(
      <span key="tree">
        tree <code className="font-mono text-[11.5px]">{shortSha(facts.treeSha)}</code>
      </span>,
    )
  }
  return (
    <p data-slot="landing-check-subject" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span className="text-soft-foreground" aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </p>
  )
}

/**
 * The empty state while the verdict does not exist yet: what the record PROVES, stage by stage.
 * The frozen subject is always persisted by the time the check run exists (stage one); the tree
 * sha appears when the sources have been merged (stage two); rows appear as commands run.
 */
function StageTrail({ check, live }: { check: LandingCheck; live: boolean }) {
  const merged = check.subject.treeSha !== undefined
  const stages: { id: string; label: string; detail: string; done: boolean }[] = [
    {
      id: 'freeze',
      label: 'Freezing the subject',
      detail: 'the invoking branch tip and the eligible sources are pinned by sha before anything merges',
      done: true,
    },
    {
      id: 'merge',
      label: 'Merging the sources',
      detail: merged ? 'merged — the subject is one tree' : 'applying the pinned sources one by one',
      done: merged,
    },
    {
      id: 'gate',
      label: 'Running the gate',
      detail: 'the repository’s own commands run on the merged tree',
      done: false,
    },
  ]
  return (
    <ol data-slot="landing-check-stages" className="flex flex-col gap-1 text-xs text-muted-foreground">
      {stages.map((stage) => (
        <li key={stage.id} data-stage={stage.id} data-state={stage.done ? 'done' : 'pending'} className="flex items-center gap-1.5">
          <StatusDot
            tone={stage.done ? 'success' : 'pending'}
            pulse={!stage.done && live}
            aria-label={stage.done ? 'done' : 'pending'}
            role="img"
          />
          <span className={cn(stage.done ? 'text-foreground' : 'text-muted-foreground')}>{stage.label}</span>
          {!stage.done ? <span className="text-soft-foreground">— {stage.detail}</span> : null}
        </li>
      ))}
    </ol>
  )
}

function emptyVerdictNote(check: LandingCheck): string {
  switch (check.verdict) {
    case 'conflict':
      return 'No command ran — the sources could not be merged into one tree, so there is nothing to check yet. Resolve the conflict and run the check again.'
    case 'nothing-to-check':
      return check.reason === 'commands-changed-vs-base'
        ? 'Nothing was executed — a source changes the recorded command plan, so the frozen base pins nothing that may run.'
        : 'Nothing was executed — the frozen base declares no commands to run.'
    case 'could-not-run':
      return 'No gate command ran — the check could not run. That is not a pass.'
    default:
      return 'No command rows were recorded for this check.'
  }
}

/**
 * One command, in the check-output card's shape (`thread-items.tsx` `ToolCard`): a chevron, the
 * verb, the command, and the outcome on the right — expanded, the tail-preserving output. Kept
 * local rather than reusing `ToolCard` because a `could-not-run` outcome is neither a tool
 * failure (red) nor a decline, and painting it as either would be the exact lie sign-off (c)
 * forbids.
 */
function LandingCheckRowCard({ row }: { row: LandingCheckRow }) {
  const [open, setOpen] = useState(false)
  const hasDetail = row.output !== undefined && row.output !== ''
  return (
    <Collapsible
      data-slot="landing-check-row"
      data-outcome={row.outcome}
      data-kind={row.kind}
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'min-w-0 overflow-hidden rounded-md border bg-card',
        row.outcome === 'failed' ? 'border-danger/25' : 'border-border',
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex min-h-[28px] w-full items-center gap-1.5 px-2.5 py-0.5 text-left text-[13px] enabled:hover:bg-muted"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-90',
            !hasDetail && 'invisible',
          )}
        />
        <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-semibold">{row.kind === 'install' ? 'Installed' : 'Ran'}</span>
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.command}</code>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {row.outcome !== 'passed' ? (
            <span className="text-xs text-muted-foreground">{humanizeLandingOutcome(row.outcome)}</span>
          ) : null}
          {typeof row.exitCode === 'number' && row.exitCode >= 0 ? (
            <span
              data-slot="landing-check-exit"
              className={cn(
                'rounded-full px-2 py-px font-mono text-[10.5px] font-semibold',
                row.exitCode === 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
              )}
            >
              {row.exitCode}
            </span>
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border bg-card-2">
          {hasDetail ? <ToolOutput text={row.output as string} streaming={false} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function humanizeLandingOutcome(outcome: LandingCheckRow['outcome']): string {
  switch (outcome) {
    case 'failed':
      return 'failed'
    case 'not-run':
      return 'not run'
    case 'could-not-run':
      return 'could not run'
    default:
      return outcome
  }
}
