import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger } from '../dispatch/tree-fs.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';

/**
 * The landing check through the RUN machinery (spec `.ai/specs/2026-09-29-landing-check.md`,
 * PR 4): `RunManager.startLandingCheck` freezes the subject and creates the check run, and the
 * check run's own `execute` materializes that subject in a worktree of its own, resolves the gate
 * from the FROZEN BASE, runs the install step first and records a verdict.
 *
 * The engine arithmetic lives in `landing-check.test.ts`; this file is about the wiring — the
 * assertions a reviewer would check by hand: the check is an ordinary run, it queues like one, the
 * subject is persisted before any merge, and a check that could not run is NEVER green.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const posix = describe.skipIf(process.platform === 'win32');

let repoRoot: string;
let dataDir: string;
let store: RunStore;
let manager: RunManager;
let currentId: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

const waitFor = async (id: string, predicate: (record: RunRecord | undefined) => boolean, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!predicate(store.getRun(id))) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = (id: string): Promise<void> => waitFor(id, (record) => TERMINAL.has(record?.status ?? ''));

const events = (id: string): Array<Record<string, unknown>> =>
  readFileSync(join(dataDir, 'runs', `${id}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

async function commit(file: string, text: string, message: string): Promise<string> {
  const target = join(repoRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, ...GIT_ID, 'commit', '-q', '-m', message);
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mkRun(options: {
  title: string;
  branch?: string;
  status?: RunRecord['status'];
  parentId?: string;
  baseBranch?: string;
  startedAt?: string;
}): RunRecord {
  const record = store.createRun({ title: options.title, workflow: 'task', task: options.title, steps: [] });
  store.updateRun(record.id, {
    status: options.status ?? 'done',
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.parentId
      ? { dispatch: { rootRunId: options.parentId, parentRunId: options.parentId } }
      : {}),
  });
  return store.getRun(record.id) as RunRecord;
}

/** base A (gate declared) → parent branch with its own commit B → child branch with commit C. */
async function parentAndChild(options: { child?: (parentSha: string) => Promise<string> } = {}): Promise<{
  parent: RunRecord;
  parentSha: string;
  child: RunRecord;
  childSha: string;
}> {
  await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok'] } }, null, 2)}\n`, 'base');
  await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
  const parentSha = await commit('b.txt', 'parent\n', 'parent work');
  const startedAt = new Date().toISOString();
  await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
  const childSha = options.child ? await options.child(parentSha) : await commit('c.txt', 'child\n', 'child work');
  await git(repoRoot, 'checkout', '-q', 'cez/parent');

  // The invoking run is STILL RUNNING — the normal case, never a 409 (review finding C1).
  const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
  const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
  appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });
  return { parent, parentSha, child, childSha };
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-landing-run-'));
  dataDir = join(repoRoot, '.ai/cezar');
  mkdirSync(dataDir, { recursive: true });
  savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
  delete process.env.CEZ_DRY_RUN;
  await git(repoRoot, 'init', '-q', '-b', 'main');
  store = RunStore.open(dataDir);
  manager = new RunManager(store, repoRoot);
  currentId = undefined;
});

afterEach(() => {
  if (currentId) manager.cancel(currentId);
  manager.dispose();
  if (savedEnv.CEZ_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = savedEnv.CEZ_DRY_RUN;
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

posix('startLandingCheck', () => {
  it('freezes the subject before any merge, runs the gate on the COMBINATION, and passes', async () => {
    const { parent, parentSha, childSha } = await parentAndChild();
    const started = await manager.startLandingCheck(parent.id, {});
    expect('runId' in started).toBe(true);
    if (!('runId' in started)) return;
    currentId = started.runId;

    // Frozen and persisted BEFORE the run's first merge: the record already names the base (the
    // invoking run's own tip — including its own commits) and the source, by sha.
    const frozen = store.getRun(started.runId);
    expect(frozen?.landingCheck?.ofRunId).toBe(parent.id);
    expect(frozen?.landingCheck?.subject.baseSha).toBe(parentSha);
    expect(frozen?.landingCheck?.subject.sources).toEqual([{ ref: 'cez/child', sha: childSha }]);
    expect(frozen?.landingCheck?.subject.order).toBe('ledger');
    expect(frozen?.landingCheck?.verdict).toBeUndefined();
    expect(frozen?.baseBranch).toBe(parentSha); // the check worktree is created AT the base
    expect(frozen?.title).toContain('Landing check');

    await settle(started.runId);
    const final = store.getRun(started.runId);
    expect(final?.status).toBe('done');
    expect(final?.landingCheck?.verdict).toBe('passed');
    expect(final?.landingCheck?.subject.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(final?.landingCheck?.results?.map((entry) => entry.outcome)).toEqual(['passed']);
    expect(final?.landingCheck?.install).toBeUndefined(); // no manifest in the frozen base
    expect(final?.landingCheck?.envNames).toBeDefined();
    expect(final?.landingCheck?.user).toBeTruthy();

    // The materialized subject IS the combination: the parent's own commit and the child's.
    const worktree = final?.worktreePath as string;
    expect(readFileSync(join(worktree, 'b.txt'), 'utf8')).toContain('parent');
    expect(readFileSync(join(worktree, 'c.txt'), 'utf8')).toContain('child');
    expect(await git(worktree, 'rev-parse', 'HEAD^{tree}')).toBe(final?.landingCheck?.subject.treeSha);
    // The check is its own run with its own branch — nothing is merged into the parent.
    expect(final?.branch).not.toBe('cez/parent');
    expect(await git(repoRoot, 'rev-parse', 'cez/parent')).toBe(parentSha);
    const output = events(started.runId).find((event) => event.type === 'check-output');
    expect(output?.status).toBe('passed');
    expect(String(output?.text)).toContain('gate-ok');
  }, 60_000);

  it('evaluates the base ALONE when nothing is eligible (sources: []), and still runs the gate', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo base-only'] } })}\n`, 'base');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    await commit('b.txt', 'parent\n', 'parent work');
    await git(repoRoot, 'checkout', '-q', 'main');
    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    expect(store.getRun(started.runId)?.landingCheck?.subject.sources).toEqual([]);
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.landingCheck?.verdict).toBe('passed');
    expect(final?.landingCheck?.reason).toBeUndefined();
    expect(final?.landingCheck?.results?.map((entry) => entry.command)).toEqual(['echo base-only']);
  }, 60_000);

  it('refuses a second landing check while one is in flight, and 404s an unknown run', async () => {
    const { parent } = await parentAndChild();
    const first = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in first)) throw new Error(first.refused);
    currentId = first.runId;

    const second = await manager.startLandingCheck(parent.id, {});
    expect('refused' in second).toBe(true);
    if ('refused' in second) {
      expect(second.notFound).toBe(false);
      expect(second.refused).toContain('already in flight');
    }
    const missing = await manager.startLandingCheck('no-such-run', {});
    expect(missing).toEqual({ refused: 'no such run: no-such-run', notFound: true });
    await settle(first.runId);
  }, 60_000);
});

posix('the verdicts that are not green', () => {
  it('a conflict stops the check: the U-files are recorded, no command runs, and the verdict says so', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await commit('shared.txt', 'base\n', 'shared base');
    const shared = await git(repoRoot, 'rev-parse', 'HEAD');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    // Two children, same file, different edits — the SECOND one cannot merge.
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/one', parentSha);
    await commit('shared.txt', 'one\n', 'one side');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/two', shared);
    await commit('shared.txt', 'two\n', 'two side');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const one = mkRun({ title: 'one', branch: 'cez/one', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    const two = mkRun({ title: 'two', branch: 'cez/two', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: one.id, parentRunId: parent.id });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: two.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    expect(final?.landingCheck?.verdict).toBe('conflict');
    expect(final?.landingCheck?.reason).toBe('merge-conflict');
    expect(final?.landingCheck?.results).toBeUndefined();
    // NO command ran: no step was added, no check step exists, and the marker was never written.
    expect(final?.steps).toEqual([]);
    expect(existsSync(join(final?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
    // The merge was aborted: the check worktree is clean and no merge is in progress.
    expect(await git(final?.worktreePath as string, 'status', '--porcelain')).toBe('');
    expect(await git(final?.worktreePath as string, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').catch(() => '')).toBe('');
    const node = events(started.runId).find((event) => event.type === 'note' && String(event.message).includes('conflicting files'));
    expect(String(node?.message)).toContain('shared.txt');
  }, 60_000);

  it('a failed install is never green: the gate commands do not run and the verdict is could-not-run', async () => {
    // A manifest with an unusable lockfile: `npm ci` exits non-zero in well under a second and
    // touches no network — the deterministic install failure this rule is about.
    await commit(
      '.ai/agentic.config.json',
      `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`,
      'base',
    );
    await commit('package.json', '{"name":"fixture","version":"1.0.0"}\n', 'manifest');
    await commit('package-lock.json', 'this is not a lockfile\n', 'broken lockfile');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent' });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    expect(final?.landingCheck?.verdict).toBe('could-not-run');
    expect(final?.landingCheck?.reason).toBe('install-failed');
    expect(final?.landingCheck?.install).toEqual({ argv: ['npm', 'ci'], exitCode: 1, outcome: 'failed' });
    expect(final?.landingCheck?.results).toBeUndefined();
    expect(existsSync(join(final?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
    // The install step is recorded as its own step, failed — visible on the run's rail.
    expect(final?.steps.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'install', status: 'failed' }]);
  }, 60_000);
});
