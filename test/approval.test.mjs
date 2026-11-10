import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalBroker } from '../host/approval.js';

/**
 * A broker whose warnings go nowhere: the timeout path is exercised on purpose.
 * @param {number} [timeoutMs]
 */
function broker(timeoutMs = 60_000) {
  const warnings = [];
  const created = createApprovalBroker({
    timeoutMs,
    logger: { warn: (message) => warnings.push(message), info: () => {} },
  });
  return { created, warnings };
}

test('a request waits until the dialog answers', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-1', sessionId: 'sess-1' });
  assert.deepEqual(created.list('sess-1').map((row) => row.runId), ['run-1']);
  const decision = created.settle({ runId: 'run-1', optionId: 'allow_once' });
  assert.equal(decision?.decision, 'allow');
  assert.deepEqual(await pending, { decision: 'allow', optionId: 'allow_once' });
  assert.deepEqual(created.list(), []);
});

test('session-wide approval keeps the same allow decision', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-2', sessionId: 'sess-1' });
  created.settle({ runId: 'run-2', optionId: 'allow_session' });
  assert.deepEqual(await pending, { decision: 'allow', optionId: 'allow_session' });
});

test('a revision request is a rejection that carries the user text', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-3', sessionId: 'sess-1' });
  created.settle({ runId: 'run-3', optionId: 'workflowRefine', reason: '  把阶段二改成只读  ' });
  assert.deepEqual(await pending, {
    decision: 'deny',
    optionId: 'workflowRefine',
    reason: '把阶段二改成只读',
    reasonSource: 'workflow_refine_feedback',
  });
});

test('a plain rejection without text falls back to the refusal script', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-4', sessionId: 'sess-1' });
  created.settle({ runId: 'run-4', optionId: 'deny' });
  const decision = await pending;
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /doesn't want to run this workflow/u);
});

test('edited settings ride along with an allow', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-5', sessionId: 'sess-1' });
  created.settle({
    runId: 'run-5',
    optionId: 'allow_once',
    adjustments: { subagentModel: ' pool/max ', maxConcurrency: 6.7 },
  });
  assert.deepEqual(await pending, {
    decision: 'allow',
    optionId: 'allow_once',
    adjustments: { subagentModel: 'pool/max', maxConcurrency: 6 },
  });
});

test('an unanswered request settles as a rejection and says so', async () => {
  const { created, warnings } = broker(10);
  const decision = await created.request({ runId: 'run-6', sessionId: 'sess-1' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.optionId, 'deny');
  assert.match(decision.reason ?? '', /not confirmed/u);
  assert.equal(warnings.length, 1);
});

test('the same run cannot queue a second question', async () => {
  const { created } = broker();
  const first = created.request({ runId: 'run-7', sessionId: 'sess-1' });
  const second = created.request({ runId: 'run-7', sessionId: 'sess-1' });
  assert.equal(first, second);
  created.settle({ runId: 'run-7', optionId: 'allow_once' });
  assert.equal((await second).decision, 'allow');
});

test('an unknown option is refused instead of answered', () => {
  const { created } = broker();
  void created.request({ runId: 'run-8', sessionId: 'sess-1' });
  assert.throws(() => created.settle({ runId: 'run-8', optionId: 'allow_forever' }), /unknown confirmation option/u);
  created.cancel('run-8');
});

test('cancelling settles the waiter so teardown leaves nothing hanging', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-9', sessionId: 'sess-1' });
  created.dispose();
  const decision = await pending;
  assert.equal(decision.decision, 'deny');
});

test('a request without a run id is refused', async () => {
  const { created } = broker();
  await assert.rejects(() => created.request({ runId: '', sessionId: 'sess-1' }), /needs a run id/u);
});

test('"allow for this session" answers later launches of the same tool', async () => {
  const { created } = broker();
  assert.equal(created.allowsSession('sess-9', 'CreateWorkflow'), false);
  const pending = created.request({ runId: 'run-10', sessionId: 'sess-9', toolName: 'CreateWorkflow' });
  created.settle({ runId: 'run-10', optionId: 'allow_session' });
  await pending;
  assert.equal(created.allowsSession('sess-9', 'CreateWorkflow'), true);
  assert.equal(created.allowsSession('sess-9', 'AmendWorkflow'), false);
  created.revokeSession('sess-9');
  assert.equal(created.allowsSession('sess-9', 'CreateWorkflow'), false);
});

test('a one-off allow grants nothing beyond its own run', async () => {
  const { created } = broker();
  const pending = created.request({ runId: 'run-11', sessionId: 'sess-10', toolName: 'CreateWorkflow' });
  created.settle({ runId: 'run-11', optionId: 'allow_once' });
  await pending;
  assert.equal(created.allowsSession('sess-10', 'CreateWorkflow'), false);
});
