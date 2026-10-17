import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv } from '../core/agent-env.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { graphRailSteps, graphToSteps, type WorkflowGraph } from './graph.ts';
import { CHECK_CONTEXT_VARS, RunManager } from './run.ts';
import { workflowStepSchema, type WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
/** The canned text a dry-run Cursor turn emits, so a resumed session carries a value we can watch. */
const CURSOR_MOCK_OUTPUT = 'mock: cursor dry-run completed the task.';

/**
 * Project and workspace secrets reach CHECK steps only (spec 2026-10-10-project-secrets-vault-options,
 * superseding the `check-env` half of 2026-10-06-agentic-e2e-checks Phase 1).
 *
 * The old advice — export the e2e model key before starting cezar — put the key in
 * `process.env`, where `buildChildEnv`'s prefix matching handed `ANTHROPIC_API_KEY` to every
 * Claude Code session and silently switched it to API billing. These tests pin the replacement:
 * the check sees the value, no agent env can, and a failing check's output is scrubbed before it
 * becomes the next agent prompt.
 */
describe('project and workspace secrets in check steps', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let secrets: SecretStore;
  let stdinLog: string;
  /** Per test, so each case starts with no store of its own — `CEZ_HOME` is one sandbox for the
   *  whole vitest worker, and a shared id would let one case read the previous one's file. */
  let project: string;
  let scope: { kind: 'project'; projectId: string; root: string };
  const workspace = { kind: 'workspace' } as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-secrets-'));
    project = `secrets-${randomUUID()}`;
    scope = { kind: 'project', projectId: project, root: repoRoot };
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_STDIN_FILE']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    stdinLog = join(repoRoot, '.mock-stdin.ndjson');
    process.env.CEZ_MOCK_STDIN_FILE = stdinLog;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
  });

  afterEach(async () => {
    manager.dispose();
    // The workspace file is shared by every case in this worker: leave it as found.
    for (const name of Object.keys((await secrets.read(workspace)).values)) await secrets.unset(workspace, name);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** Wait for a real text event to hit the run's NDJSON, then return its persisted text. */
  const waitForPersistedText = async (id: string): Promise<string> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const text = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type?: string; text?: string })
          .filter((event) => event.type === 'text' && typeof event.text === 'string')
          .map((event) => event.text as string)
          .join('\n');
        if (text) return text;
      } catch {
        // The NDJSON file may not exist until the resumed session emits its first event.
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for a persisted text event');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const until = async (id: string, pred: (record: RunRecord) => boolean, ms = 20_000): Promise<RunRecord> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const record = store.getRun(id);
      if (record && pred(record)) return record;
      if (Date.now() > deadline) throw new Error(`timed out; status=${record?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const checkOutputs = (id: string): string[] =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string })
      .filter((event) => event.type === 'check-output')
      .map((event) => event.text ?? '');

  const notes = (id: string): string[] =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((event) => event.type === 'note')
      .map((event) => event.message ?? '');

  const checkOnly = (command: string, extra: Partial<WorkflowDef['steps'][number]> = {}): WorkflowDef => ({
    name: 'implement-and-check',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command, ...extra },
    ],
  });

  it('hands a stored project secret to the check step', async () => {
    await secrets.set(scope, 'E2E_FLAG', 'on');
    const record = manager.startRun(checkOnly('echo "flag=$E2E_FLAG"'), { task: 'mock:done go', worktree: false });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(checkOutputs(record.id)).toEqual(['flag=on']);
  }, 30_000);

  it('hands a workspace secret too, the project\'s winning on a shared name, and withholds other audiences', async () => {
    // Short values on purpose: anything at or above `MIN_SECRET_LEN` is redacted from the transcript
    // this test reads back (pinned below, in the scrubbing case).
    await secrets.set(workspace, 'SHARED', 'from-ws');
    await secrets.set(workspace, 'WS_ONLY', 'ws-only');
    await secrets.set(workspace, 'LLM_KEY', 'cezar-only-key-value', ['cezar']);
    await secrets.set(scope, 'SHARED', 'from-proj');
    const record = manager.startRun(checkOnly('echo "$SHARED/$WS_ONLY/${LLM_KEY:-unset}"'), { task: 'mock:done go', worktree: false });
    await settle(record.id);

    expect(checkOutputs(record.id)).toEqual(['from-proj/ws-only/unset']);
  }, 30_000);

  it('honours the step\'s secrets: binding — exactly those, renamed on request, the rest said on the step', async () => {
    await secrets.set(scope, 'E2E_KEY', 'bound-key');
    await secrets.set(scope, 'OTHER', 'not-bound-value');
    await secrets.set(scope, 'LLM_KEY', 'cezar-only-key-value', ['cezar']);
    const record = manager.startRun(
      checkOnly('echo "${AI_GATEWAY_API_KEY:-unset}/${E2E_KEY:-unset}/${OTHER:-unset}/${LLM_KEY:-unset}"', {
        secrets: [{ name: 'E2E_KEY', as: 'AI_GATEWAY_API_KEY' }, 'LLM_KEY', 'MISSING'],
      }),
      { task: 'mock:done go', worktree: false },
    );
    await settle(record.id);

    expect(checkOutputs(record.id)).toEqual(['bound-key/unset/unset/unset']);
    expect(notes(record.id)).toEqual(expect.arrayContaining([
      'secret LLM_KEY is not available to checks (audiences: cezar)',
      'secret MISSING is not stored for this project or workspace',
    ]));
  }, 30_000);

  it('refuses secrets: on an agent step at load time — YAML cannot route a secret to a backend', () => {
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: ['E2E_KEY'] }).success).toBe(true);
    const refused = workflowStepSchema.safeParse({ id: 'implement', prompt: '{{task}}', secrets: ['E2E_KEY'] });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain('check steps only');
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: ['PATH'] }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'verify', command: 'true', secrets: [] }).success).toBe(false);
  });

  it('never puts a secret where an agent env can see it', async () => {
    const key = 'sk-ant-api03-checkonlycheckonlycheckonly';
    await secrets.set(scope, 'ANTHROPIC_API_KEY', key);
    await secrets.set(scope, 'FOO', 'check-only-value');
    const record = manager.startRun(checkOnly('test "$FOO" = check-only-value'), {
      task: 'mock:done go',
      worktree: false,
    });
    await settle(record.id);

    // The check got both; the run passed only because `FOO` was there.
    expect(store.getRun(record.id)?.status).toBe('done');
    // The regression pin: nothing reached `process.env`, so no backend's prefix curation
    // (claude: ANTHROPIC_*, codex: OPENAI_*, opencode/pi: the multi-provider list) can pass it on.
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(key);
    expect(process.env.FOO).toBeUndefined();
    for (const backend of ['claude', 'codex', 'opencode'] as const) {
      const env = buildChildEnv({ backend });
      expect(env.ANTHROPIC_API_KEY).not.toBe(key);
      expect(env.FOO).toBeUndefined();
    }
  }, 30_000);

  it('scrubs a failing check\'s output before it becomes the next agent prompt', async () => {
    const credential = 'e2e-credential-value-0123456789';
    const token = 'sk-ant-api03-leakedleakedleakedleaked';
    await secrets.set(scope, 'E2E_GATEWAY_KEY', credential);
    const workflow: WorkflowDef = {
      name: 'implement-and-check',
      source: 'file',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        {
          id: 'verify',
          name: 'Verify',
          command: `echo "auth failed with $E2E_GATEWAY_KEY and ${token}"; exit 1`,
          onFail: { retry: 'implement', max: 1 },
        },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done fix it', worktree: false });
    await settle(record.id);

    const prompts = readFileSync(stdinLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { userText: string }).userText);
    const retried = prompts.find((text) => text.includes('A verification command failed'));
    expect(retried).toBeDefined();
    expect(retried).toContain('[REDACTED]');
    expect(retried).not.toContain(credential);
    expect(retried).not.toContain(token);
  }, 40_000);

  it('scrubs a passing check\'s output before a node reference reaches the next agent, and before it is persisted', async () => {
    const credential = 'e2e-credential-value-0123456789';
    await secrets.set(scope, 'E2E_GATEWAY_KEY', credential);
    const record = manager.startRun(
      {
        name: 'check-then-implement',
        source: 'file',
        steps: [
          { id: 'verify', name: 'Verify', command: 'echo "$E2E_GATEWAY_KEY"' },
          { id: 'implement', name: 'Implement', prompt: '{{task}} — check said: {{nodes.verify.output}}' },
        ],
      },
      { task: 'mock:done go', worktree: false },
    );
    await settle(record.id);

    const prompts = readFileSync(stdinLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { userText: string }).userText);
    const nextPrompt = prompts.find((text) => text.includes('check said:'));
    expect(nextPrompt).toBeDefined();
    expect(nextPrompt).toContain('[REDACTED]');
    expect(nextPrompt).not.toContain(credential);

    const persisted = store.getRun(record.id)?.graphState?.outputs?.verify;
    expect(persisted?.output).toContain('[REDACTED]');
    expect(persisted?.output).not.toContain(credential);

    store.flush();
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8')).not.toContain(credential);
  }, 40_000);

  it('scrubs a persisted graph output when a restart replays it into a later agent prompt', async () => {
    const credential = 'resume-replay-secret-0123456789';
    await secrets.set(scope, 'RESUME_GATEWAY_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo clean-output' },
        { id: 'gate', type: 'gate.human', message: 'Ship?' },
        { id: 'after', type: 'agent', prompt: 'mock:done / {{nodes.first.output}}' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'gate' },
        { from: 'gate.approve', to: 'after' },
      ],
    };
    const record = manager.startRun(
      { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      { task: 'x', worktree: false },
    );
    const parked = await until(record.id, (run) => run.status === 'waiting');
    expect(parked.graphState?.cursor).toBe('gate');

    // Simulate a record written before the fresh-path redaction: the old process persisted a
    // registered checks secret raw. A restart must not hand it to the next agent or re-persist it.
    store.updateRun(record.id, {
      graphState: {
        ...parked.graphState!,
        outputs: { ...(parked.graphState?.outputs ?? {}), first: { exitCode: 0, output: credential } },
      },
    });
    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();
    await until(record.id, (run) => run.status === 'waiting');

    manager.sendMessage(record.id, [{ type: 'text', text: 'Approve' }]);
    await settle(record.id);

    const prompts = readFileSync(stdinLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { userText: string }).userText);
    const resumed = prompts.find((text) => text.includes('mock:done /'));
    expect(resumed).toBeDefined();
    expect(resumed).toContain('[REDACTED]');
    expect(resumed).not.toContain(credential);

    store.flush();
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8')).not.toContain(credential);
  }, 40_000);

  it('scrubs legacy graph outputs for every recovered record, including an agent-cursor run', async () => {
    const credential = 'agent-cursor-legacy-secret-0123456789';
    await secrets.set(scope, 'AGENT_CURSOR_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first' },
        { id: 'agent', type: 'agent', prompt: 'mock:done' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'agent' },
        { from: 'agent', to: 'finish' },
      ],
    };
    const definition: WorkflowDef = {
      name: 'graph',
      source: 'file',
      steps: graphToSteps(graph),
      graph,
    };
    const parked = store.createRun({
      title: 'parked', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(parked.id, {
      status: 'waiting',
      workflowDef: definition,
      graphState: { loops: {}, taken: [], cursor: 'agent', outputs: { first: { exitCode: 0, output: credential } } },
    });
    const finished = store.createRun({
      title: 'finished', workflow: 'graph', task: 'x', worktree: false, steps: [],
    });
    store.updateRun(finished.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: credential } } },
    });
    const untrusted = store.createRun({
      title: 'fork', workflow: 'graph', task: 'x', worktree: false, steps: [],
    });
    store.updateRun(untrusted.id, {
      status: 'done',
      untrustedHead: true,
      finishedAt: new Date().toISOString(),
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: 'fork-output' } } },
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const register = vi.spyOn(store, 'registerRunSecrets');
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();

    for (const id of [parked.id, finished.id]) {
      const output = store.getRun(id)?.graphState?.outputs?.first?.output;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain(credential);
    }
    // A fork head never had the checks audience; recovery must not register it for that run.
    expect(store.getRun(untrusted.id)?.graphState?.outputs?.first?.output).toBe('fork-output');
    expect(register.mock.calls.some(([runId]) => runId === untrusted.id)).toBe(false);

    const runsJson = readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8');
    expect(runsJson).not.toContain(credential);

    const app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    for (const id of [parked.id, finished.id]) {
      const response = await apiRequest(app, `/api/v1/runs/${id}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(credential);
    }
  }, 40_000);

  it('keeps the boot-scrub redactor for a live agent-cursor run that recovery resumes', async () => {
    const credential = CURSOR_MOCK_OUTPUT;
    await secrets.set(scope, 'LIVE_AGENT_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first' },
        { id: 'agent', type: 'agent', prompt: 'mock:done' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'agent' },
        { from: 'agent', to: 'finish' },
      ],
    };
    const running = store.createRun({
      title: 'running', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(running.id, {
      status: 'running',
      runner: 'cursor',
      workflowDef: { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      graphState: { loops: {}, taken: [], cursor: 'agent', outputs: { first: { exitCode: 0, output: credential } } },
    });
    store.updateStep(running.id, 'agent', {
      status: 'running', sessionId: 'legacy-agent-session', backend: 'cursor',
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();

    // The scrub must leave the redactor registered while recovery drives this run onward: its
    // resumed session may echo a value from the pre-fix context before any check runs again.
    expect(store.getRun(running.id)?.graphState?.outputs?.first?.output).toContain('[REDACTED]');
    expect(store.redactRunText(running.id, credential)).toBe('[REDACTED]');
    // Waiting for the resumed turn's own text event proves recovery actually started it; parsing
    // the NDJSON then proves the event was redacted on the real persistence path, not just in a
    // synthetic append.
    const text = await waitForPersistedText(running.id);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(credential);
  }, 40_000);

  it('rehydrates before a user Continue of a recovered waiting run can persist text', async () => {
    const credential = CURSOR_MOCK_OUTPUT;
    await secrets.set(scope, 'WAITING_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first' },
        { id: 'agent', type: 'agent', prompt: 'mock:done' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'agent' },
        { from: 'agent', to: 'finish' },
      ],
    };
    const waiting = store.createRun({
      title: 'waiting', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(waiting.id, {
      status: 'waiting',
      runner: 'cursor',
      workflowDef: { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      graphState: { loops: {}, taken: [], cursor: 'agent', outputs: { first: { exitCode: 0, output: credential } } },
    });
    store.updateStep(waiting.id, 'agent', {
      status: 'waiting', sessionId: 'legacy-agent-session', backend: 'cursor',
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();

    expect(store.getRun(waiting.id)?.status).toBe('done');
    expect(manager.continueRun(waiting.id, { text: 'Continue probe' })).toEqual({ ok: true });
    const text = await waitForPersistedText(waiting.id);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(credential);
  }, 40_000);

  it('keeps the checks audience out of a user Continue of an untrusted waiting run', async () => {
    const credential = CURSOR_MOCK_OUTPUT;
    await secrets.set(scope, 'WAITING_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first' },
        { id: 'agent', type: 'agent', prompt: 'mock:done' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'agent' },
        { from: 'agent', to: 'finish' },
      ],
    };
    const waiting = store.createRun({
      title: 'untrusted waiting', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(waiting.id, {
      status: 'waiting',
      runner: 'cursor',
      untrustedHead: true,
      workflowDef: { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      graphState: { loops: {}, taken: [], cursor: 'agent', outputs: { first: { exitCode: 0, output: credential } } },
    });
    store.updateStep(waiting.id, 'agent', {
      status: 'waiting', sessionId: 'legacy-agent-session', backend: 'cursor',
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();

    expect(store.getRun(waiting.id)?.status).toBe('done');
    expect(manager.continueRun(waiting.id, { text: 'Continue probe' })).toEqual({ ok: true });
    const text = await waitForPersistedText(waiting.id);
    // A fork head never had checks secrets: rehydrating them on Continue would over-redact and
    // silently change the meaning of its transcript. The raw canned value proves no rehydration.
    expect(text).toContain(credential);
    expect(store.redactRunText(waiting.id, credential)).toBe(credential);
  }, 40_000);

  it('releases the boot-scrub redactor when a recovered queued run cannot be revived', async () => {
    const credential = 'queued-recovery-failure-secret-0123456789';
    await secrets.set(scope, 'QUEUED_KEY', credential);
    const queued = store.createRun({
      title: 'queued failure', workflow: 'missing-workflow', task: 'x', worktree: false, steps: [],
    });
    store.updateRun(queued.id, {
      status: 'queued',
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: credential } } },
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();

    expect(store.getRun(queued.id)?.status).toBe('failed');
    expect(readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8')).not.toContain(credential);
    expect(store.redactRunText(queued.id, credential)).toBe(credential);
  }, 40_000);

  it('releases the boot-scrub redactor when a recovered queued run is cancelled', async () => {
    const credential = 'queued-cancel-secret-0123456789';
    await secrets.set(scope, 'QUEUED_KEY', credential);
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'first', type: 'check', command: 'echo first' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'first' },
        { from: 'first', to: 'finish' },
      ],
    };
    const queued = store.createRun({
      title: 'queued cancel', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(queued.id, {
      status: 'queued',
      workflowDef: { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: credential } } },
    });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    (manager as unknown as { pump: () => Promise<void> }).pump = async () => {};
    await manager.recover();

    // While it is still queued, the boot scrub's checks audience must be resident: a resumed
    // continuation may echo the pre-fix output before its own check registers.
    expect(store.redactRunText(queued.id, credential)).toBe('[REDACTED]');
    expect(manager.cancel(queued.id)).toBe(true);
    expect(store.getRun(queued.id)?.status).toBe('cancelled');
    expect(store.redactRunText(queued.id, credential)).toBe(credential);
  }, 40_000);

  it('releases the boot-scrub redactor when a recovered running run cannot resume', async () => {
    const credential = 'running-resume-failure-secret-0123456789';
    await secrets.set(scope, 'RUNNING_KEY', credential);
    const running = store.createRun({ title: 'running failure', workflow: 'graph', task: 'x', worktree: false, steps: [] });
    store.updateRun(running.id, {
      status: 'running',
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: credential } } },
    });
    store.addStep(running.id, { id: 'agent', name: 'Agent', kind: 'agent' });
    store.updateStep(running.id, 'agent', { status: 'running', sessionId: 'legacy-agent-session' });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    const continueSpy = vi
      .spyOn(manager as unknown as { continueRun: () => { ok: false; error: string } }, 'continueRun')
      .mockReturnValue({ ok: false, error: 'probe — cannot resume' });
    try {
      await manager.recover();
      expect(continueSpy).toHaveBeenCalledTimes(1);
      expect(store.redactRunText(running.id, credential)).toBe(credential);
    } finally {
      continueSpy.mockRestore();
    }
  }, 40_000);

  it('reserves a continuation in active before awaiting its rehydration', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'agent', type: 'agent', prompt: 'mock:done' },
        { id: 'finish', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'agent' },
        { from: 'agent', to: 'finish' },
      ],
    };
    const waiting = store.createRun({
      title: 'reentrancy', workflow: 'graph', task: 'x', worktree: false, steps: graphRailSteps(graph),
    });
    store.updateRun(waiting.id, {
      status: 'waiting',
      workflowDef: { name: 'graph', source: 'file', steps: graphToSteps(graph), graph },
      graphState: { loops: {}, taken: [], cursor: 'agent' },
    });
    store.updateStep(waiting.id, 'agent', { status: 'waiting', sessionId: 'legacy-agent-session' });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();
    expect(store.getRun(waiting.id)?.status).toBe('done');

    let release!: (error?: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(error) : resolve());
    });
    const spy = vi
      .spyOn(manager as unknown as { rehydrateResumeRedaction: (id: string) => Promise<void> }, 'rehydrateResumeRedaction')
      .mockImplementation(() => gate);
    try {
      expect(manager.continueRun(waiting.id, { text: 'first' })).toEqual({ ok: true });
      const activeDeadline = Date.now() + 5_000;
      while (!manager.isActive(waiting.id)) {
        if (Date.now() > activeDeadline) throw new Error('continuation never reserved the run');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The synchronous reservation must be visible while rehydration is still pending.
      expect(manager.continueRun(waiting.id, { text: 'second' })).toEqual({
        ok: false, error: 'run is still active',
      });

      release(new Error('probe — release the gated continuation'));
      const failedDeadline = Date.now() + 5_000;
      while (store.getRun(waiting.id)?.status !== 'failed') {
        if (Date.now() > failedDeadline) throw new Error('gated continuation did not settle');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
      spy.mockRestore();
    }
  }, 40_000);

  it('clears secrets that resolve after a cancel during rehydration', async () => {
    const credential = 'cancel-during-rehydration-secret-0123456789';
    await secrets.set(scope, 'CANCEL_KEY', credential);
    const waiting = store.createRun({ title: 'cancel during rehydration', workflow: 'graph', task: 'x', worktree: false, steps: [] });
    store.updateRun(waiting.id, {
      status: 'waiting',
      graphState: { loops: {}, taken: [], outputs: { first: { exitCode: 0, output: credential } } },
    });
    store.addStep(waiting.id, { id: 'agent', name: 'Agent', kind: 'agent' });
    store.updateStep(waiting.id, 'agent', { status: 'waiting', sessionId: 'legacy-agent-session' });

    manager.dispose();
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { projectId: project, secrets });
    await manager.recover();
    expect(store.getRun(waiting.id)?.status).toBe('done');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internals = manager as unknown as { rehydrateResumeRedaction: (id: string) => Promise<void> };
    const realRehydrate = internals.rehydrateResumeRedaction.bind(manager);
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => { registered = resolve; });
    const spy = vi.spyOn(internals, 'rehydrateResumeRedaction').mockImplementation(async (id) => {
      await gate;
      await realRehydrate(id);
      registered();
    });
    try {
      expect(manager.continueRun(waiting.id, { text: 'cancel probe' })).toEqual({ ok: true });
      const activeDeadline = Date.now() + 5_000;
      while (!manager.isActive(waiting.id)) {
        if (Date.now() > activeDeadline) throw new Error('continuation never reserved the run');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(manager.cancel(waiting.id)).toBe(true);
      expect(store.getRun(waiting.id)?.status).toBe('cancelled');
      expect(store.redactRunText(waiting.id, credential)).toBe(credential);

      release();
      await registration;
      const cleanDeadline = Date.now() + 5_000;
      while (store.redactRunText(waiting.id, credential) !== credential) {
        if (Date.now() > cleanDeadline) throw new Error('resolved rehydration left the cancelled run redacted');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(store.getRun(waiting.id)?.status).toBe('cancelled');
    } finally {
      release();
      spy.mockRestore();
    }
  }, 40_000);

  it('without a secret store the check runs with the minimal env: toolchain vars, no vendor keys (#1164)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-exported-for-e2e-0123456789';
    try {
      const record = manager.startRun(
        checkOnly('echo "${ANTHROPIC_API_KEY:-unset}/${PATH:+path}"'),
        { task: 'mock:done go', worktree: false },
      );
      await settle(record.id);
      expect(store.getRun(record.id)?.status).toBe('done');
      // An exported provider key no longer rides along; it has to be stored as a secret.
      expect(checkOutputs(record.id)).toEqual(['unset/path']);
      // Nothing stored is the ordinary case: it degrades silently, with no note to explain.
      expect(notes(record.id).filter((note) => note.includes('secret'))).toEqual([]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 30_000);

  it('says so on the step when it found a store it could not use', async () => {
    // A store written for a DIFFERENT project root — a moved checkout, a changed symlink. It
    // reads as empty by design, and the value is write-only, so without this note the user sees
    // an empty `secrets list` and cannot tell "never stored" from "stored but ignored".
    const elsewhere = mkdtempSync(join(tmpdir(), 'cez-secrets-elsewhere-'));
    try {
      await secrets.set({ ...scope, root: elsewhere }, 'E2E_FLAG', 'on');
      const record = manager.startRun(checkOnly('echo "flag=$E2E_FLAG"'), { task: 'mock:done go', worktree: false });
      await settle(record.id);

      expect(store.getRun(record.id)?.status).toBe('done');
      expect(checkOutputs(record.id)).toEqual(['flag=']);
      expect(notes(record.id).some((note) => /project secrets skipped — the store belongs to another project root/.test(note))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The run context a check step gets (spec 2026-10-06-agentic-e2e-checks Phase 2): what it is
 * verifying, where, which attempt this is, and a cache shared across the project's worktrees.
 */
describe('run context for check steps', () => {
  const PROJECT = 'check-context-project';
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-context-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_RUN_ID', 'CEZ_GITHUB_NUMBER', 'CEZ_PROJECT_ID', 'CEZ_API_URL']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    // What a cezar started inside another cezar task inherits: it must never leak through.
    process.env.CEZ_RUN_ID = 'outer-task';
    process.env.CEZ_GITHUB_NUMBER = '999';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { projectId: PROJECT });
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const contextOf = (runId: string, stepId: string, cwd: string) =>
    (manager as unknown as {
      checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
    }).checkStepEnv(runId, { cwd }, { id: stepId }, () => undefined);

  it('sets every run variable on a worktree run, and nothing GitHub- or PR-only', async () => {
    const record = manager.startRun(
      {
        name: 'implement-and-check',
        source: 'file',
        steps: [
          { id: 'implement', name: 'Implement', prompt: '{{task}}' },
          { id: 'verify', name: 'Verify', command: 'env | grep "^CEZ_" | sort > "$CEZ_WORKTREE/../check-env.txt"' },
        ],
      },
      { task: 'mock:done go' },
    );
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    const finished = store.getRun(record.id)!;
    expect(['done', 'review']).toContain(finished.status);
    const seen = Object.fromEntries(
      readFileSync(join(finished.worktreePath!, '..', 'check-env.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(seen).toMatchObject({
      CEZ_RUN_ID: record.id,
      CEZ_PROJECT_ID: PROJECT,
      CEZ_WORKTREE: finished.worktreePath,
      CEZ_BRANCH: finished.branch,
      CEZ_BASE: finished.baseBranch,
      CEZ_STEP_ID: 'verify',
      CEZ_ATTEMPT: '1',
    });
    expect(seen.CEZ_SHARED_CACHE_DIR).toBe(join(process.env.CEZ_HOME!, 'cache', PROJECT));
    // Absent, not empty — including the stale values this process inherited. Driven off
    // `CHECK_CONTEXT_VARS` rather than a second hand-written list, so a name added to the
    // list without a value cannot quietly stop being asserted here.
    const expected = new Set(Object.keys(seen));
    for (const name of CHECK_CONTEXT_VARS) {
      if (expected.has(name)) continue;
      expect(seen).not.toHaveProperty(name);
    }
    for (const name of ['CEZ_GITHUB_REPO', 'CEZ_GITHUB_NUMBER', 'CEZ_GITHUB_EVENT', 'CEZ_PR_HEAD_SHA', 'CEZ_PR_HEAD_REF', 'CEZ_PR_BASE_REF']) {
      expect(seen).not.toHaveProperty(name);
    }
  }, 40_000);

  /**
   * The minimal check env (#1164) inherits no `CEZ_*` at all, so a projectless headless
   * `cezar run` forwards neither the operator's `CEZ_PROJECT_ID` nor `CEZ_API_URL` — the pair
   * stays consistent, never one without the other.
   */
  it('forwards no inherited CEZ_PROJECT_ID or CEZ_API_URL when the run has no project of its own', async () => {
    process.env.CEZ_PROJECT_ID = 'operators-choice';
    process.env.CEZ_API_URL = 'http://127.0.0.1:4321';
    const projectless = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
      const env = await (projectless as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(env).not.toHaveProperty('CEZ_PROJECT_ID');
      expect(env).not.toHaveProperty('CEZ_API_URL');
      expect(env).not.toHaveProperty('CEZ_SHARED_CACHE_DIR');
      expect(env.CEZ_RUN_ID).toBe(record.id);
    } finally {
      projectless.dispose();
    }
  });

  it('replaces an inherited CEZ_PROJECT_ID when the run does have a project', async () => {
    process.env.CEZ_PROJECT_ID = 'operators-choice';
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    expect((await contextOf(record.id, 'verify', repoRoot)).CEZ_PROJECT_ID).toBe(PROJECT);
  });

  /**
   * The id becomes a path segment, so it is re-validated where that happens — the same guard
   * `workspace/secrets.ts` applies before building `~/.cezar/secrets/<projectId>.json`. No
   * caller can produce this id today (the workspace schema drops it, `allocateProjectSlug`
   * cannot emit it); the point is that a `recursive` mkdir is not where we want to find out.
   */
  it('omits the cache directory rather than escaping the cezar home on a non-slug project id', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    const escaping = new RunManager(store, repoRoot, { projectId: '../../escape' });
    try {
      const env = await (escaping as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(env).not.toHaveProperty('CEZ_SHARED_CACHE_DIR');
    } finally {
      escaping.dispose();
    }
  });

  it('adds the GitHub provenance of an automation run', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    store.updateRun(record.id, {
      automation: {
        automationId: 'a1',
        automationRevision: 1,
        receiptId: 'r1',
        event: 'pull_request.opened',
        githubUrl: 'https://github.com/acme/shop/pull/42',
      },
    });
    const env = await contextOf(record.id, 'verify', repoRoot);
    expect(env).toMatchObject({ CEZ_GITHUB_REPO: 'acme/shop', CEZ_GITHUB_NUMBER: '42', CEZ_GITHUB_EVENT: 'pull_request.opened' });
    expect(env).not.toHaveProperty('CEZ_BRANCH');
  });

  it('counts the attempt from the step\'s own iterations', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    store.updateStep(record.id, 'verify', { iterations: 3 });
    expect((await contextOf(record.id, 'verify', repoRoot)).CEZ_ATTEMPT).toBe('3');
  });

  it('shares one 0700 cache directory per project, and a different one per project', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });
    const first = (await contextOf(record.id, 'verify', repoRoot)).CEZ_SHARED_CACHE_DIR!;
    const second = (await contextOf(record.id, 'verify', repoRoot)).CEZ_SHARED_CACHE_DIR!;
    expect(second).toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    const other = new RunManager(store, repoRoot, { projectId: 'another-project' });
    try {
      const theirs = await (other as unknown as {
        checkStepEnv(runId: string, state: { cwd: string }, step: { id: string }, emit: () => void): Promise<NodeJS.ProcessEnv>;
      }).checkStepEnv(record.id, { cwd: repoRoot }, { id: 'verify' }, () => undefined);
      expect(theirs.CEZ_SHARED_CACHE_DIR).not.toBe(first);
    } finally {
      other.dispose();
    }
  });
});
