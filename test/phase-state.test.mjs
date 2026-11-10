/**
 * Unit tests for host/phase-state.js — the §3.3 `Wm` branches: running / completed / errored /
 * stopped, alongside filtering, hole precedence, the fallback phase order and the prefix rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Hm,
  MAX_PHASE_NAME_LENGTH,
  Um,
  Vm,
  Wm,
  derivePhaseStates,
  isNodeActivelyRunning,
  isRunActive,
  phaseNameMatches,
} from '../host/phase-state.js';

test('Vm/Hm/Um mirror the ZCode helpers', () => {
  assert.equal(Vm('pending'), true);
  assert.equal(Vm('running'), true);
  assert.equal(Vm('completed'), false);
  assert.equal(Vm('errored'), false);
  assert.equal(Vm('stopped'), false);

  assert.equal(Hm({ phase: 'executing' }), true);
  assert.equal(Hm({ phase: 'repairing' }), true);
  assert.equal(Hm({ phase: 'nudged' }), true);
  assert.equal(Hm({ phase: 'waiting' }), false);
  assert.equal(Hm({ phase: 'settled' }), false);

  assert.equal(Um('prep', 'prep'), true);
  assert.equal(Um('prep', 'prep-extra'), false);
  const truncated = 'p'.repeat(MAX_PHASE_NAME_LENGTH);
  assert.equal(Um(truncated, `${truncated}-suffix`), true);
});

test('aliases point at the same implementations', () => {
  assert.equal(Vm, isRunActive);
  assert.equal(Hm, isNodeActivelyRunning);
  assert.equal(Um, phaseNameMatches);
  assert.equal(Wm, derivePhaseStates);
});

test('running: current phase and phases with an executing node are running, entered ones done', () => {
  const phases = derivePhaseStates({
    status: 'running',
    phaseNames: ['prep', 'build', 'ship'],
    currentPhase: 'build',
    phases: [
      { name: 'prep', rounds: 1 },
      { name: 'build', rounds: 1 },
    ],
    nodes: [
      { phase: 'executing', phaseName: 'prep' },
      { phase: 'settled', phaseName: 'build' },
    ],
  });
  assert.deepEqual(phases.map((phase) => [phase.name, phase.status]), [
    ['prep', 'running'],
    ['build', 'running'],
    ['ship', 'pending'],
  ]);
});

test('completed: entered phases are done, never-entered ones pending', () => {
  const phases = derivePhaseStates({
    status: 'completed',
    phaseNames: ['prep', 'build', 'ship'],
    currentPhase: 'build',
    phases: [
      { name: 'prep', rounds: 1 },
      { name: 'build', rounds: 1 },
    ],
    // 结束后的节点残留不能把阶段点亮。
    nodes: [{ phase: 'executing', phaseName: 'prep' }],
  });
  assert.deepEqual(phases.map((phase) => phase.status), ['done', 'done', 'pending']);
});

test('errored: the current phase is failed, entered ones done', () => {
  const phases = derivePhaseStates({
    status: 'errored',
    phaseNames: ['prep', 'build', 'ship'],
    currentPhase: 'build',
    phases: [
      { name: 'prep', rounds: 1 },
      { name: 'build', rounds: 2 },
    ],
  });
  assert.deepEqual(phases.map((phase) => [phase.name, phase.status]), [
    ['prep', 'done'],
    ['build', 'failed'],
    ['ship', 'pending'],
  ]);
});

test('stopped: the current phase returns to pending so it can resume', () => {
  const phases = derivePhaseStates({
    status: 'stopped',
    phaseNames: ['prep', 'build', 'ship'],
    currentPhase: 'build',
    phases: [
      { name: 'prep', rounds: 1 },
      { name: 'build', rounds: 1 },
    ],
  });
  assert.deepEqual(phases.map((phase) => phase.status), ['done', 'pending', 'pending']);
});

test('pending run is active: current phase is running', () => {
  const phases = derivePhaseStates({
    status: 'pending',
    phaseNames: ['prep'],
    currentPhase: 'prep',
  });
  assert.equal(phases[0].status, 'running');
});

test('without phaseNames the order falls back to entered phases + currentPhase', () => {
  const phases = derivePhaseStates({
    status: 'running',
    phases: [{ name: 'prep', rounds: 1 }],
    currentPhase: 'build',
  });
  assert.deepEqual(phases.map((phase) => phase.name), ['prep', 'build']);
  assert.deepEqual(phases.map((phase) => phase.status), ['done', 'running']);
});

test('an already-entered currentPhase is not appended twice', () => {
  const phases = derivePhaseStates({
    status: 'running',
    phases: [{ name: 'prep', rounds: 1 }],
    currentPhase: 'prep',
  });
  assert.deepEqual(phases.map((phase) => phase.name), ['prep']);
});

test('alongside keeps valid parallel indexes only and drops the field when empty', () => {
  const phases = derivePhaseStates({
    status: 'running',
    phaseNames: ['prep', 'build', 'ship'],
    phaseAlongside: [
      [1, 1, -1, 5, 0], // 1 重复、-1/5 越界、0 是自身 → 只剩 1
      [2],
      [0, 1],
    ],
  });
  // Wm 只过滤非法下标，不去重（与 validation.js:8589-8591 一致）。
  assert.deepEqual(phases[0].alongside, [1, 1]);
  assert.deepEqual(phases[1].alongside, [2]);
  assert.deepEqual(phases[2].alongside, [0, 1]);

  const plain = derivePhaseStates({
    status: 'running',
    phaseNames: ['prep'],
    phaseAlongside: [[0, 3]],
  });
  assert.equal('alongside' in plain[0], false);
});

test('hole state: phaseHoles is open, a waiting hole name wins over open', () => {
  const phases = derivePhaseStates({
    status: 'running',
    phaseNames: ['prep', 'build', 'ship'],
    phaseHoles: [1, 2],
    holes: [{ name: 'ship', state: 'waiting' }],
  });
  assert.equal(phases[0].hole, undefined);
  assert.equal(phases[1].hole, 'open');
  assert.equal(phases[2].hole, 'waiting');

  const filled = derivePhaseStates({
    status: 'running',
    phaseNames: ['prep'],
    holes: [{ name: 'prep', state: 'filled' }],
  });
  assert.equal('hole' in filled[0], false);
});

test('phase list is capped at 32 and duplicates in the declared order are preserved', () => {
  const phaseNames = Array.from({ length: 40 }, (_, index) => `phase-${index}`);
  const phases = derivePhaseStates({ status: 'running', phaseNames });
  assert.equal(phases.length, 32);
  assert.equal(phases[31].name, 'phase-31');
});
