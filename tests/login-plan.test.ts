import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOGIN_STEPS, parseLoginArgs } from '../src/login-plan.js';

const steps = (args: string[]): string[] => [...parseLoginArgs(args).steps].sort();

test('no options runs every login step', () => {
  const plan = parseLoginArgs([]);
  assert.deepEqual([...plan.steps].sort(), [...LOGIN_STEPS].sort());
  assert.equal(plan.fresh, false);
  assert.equal(plan.catalog, false);
  assert.equal(plan.only, false);
});

test('--only selects exactly the named services in both spellings', () => {
  assert.deepEqual(steps(['--only', 'mytu,timetable']), ['mytu', 'timetable']);
  assert.deepEqual(steps(['--only=mytu,timetable']), ['mytu', 'timetable']);
  assert.deepEqual(steps(['--only', ' Timetable , MyTu ']), ['mytu', 'timetable']);
  assert.deepEqual(steps(['--only', 'brightspace']), ['brightspace']);
  assert.equal(parseLoginArgs(['--only', 'mytu']).only, true);
});

test('--only mytu,timetable does not include the Brightspace sign-in window', () => {
  assert.ok(!parseLoginArgs(['--only', 'mytu,timetable']).steps.has('brightspace'));
});

test('a misspelled or empty --only service fails instead of silently skipping every step', () => {
  for (const args of [['--only', 'timetables'], ['--only', 'mytu,osiris'], ['--only', ''], ['--only=']]) {
    assert.throws(() => parseLoginArgs(args), { code: 'INVALID_ARGUMENT' });
  }
});

test('--only never swallows the next option as its value', () => {
  assert.throws(() => parseLoginArgs(['--only', '--fresh']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseLoginArgs(['--only']), { code: 'INVALID_ARGUMENT' });
});

test('unknown options are rejected rather than ignored', () => {
  assert.throws(() => parseLoginArgs(['--onlyy', 'mytu']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseLoginArgs(['--catalogue']), { code: 'INVALID_ARGUMENT' });
});

test('--fresh and --catalog are recognised, and --catalog stays a Brightspace-only sign-in', () => {
  const fresh = parseLoginArgs(['--fresh']);
  assert.equal(fresh.fresh, true);
  const catalog = parseLoginArgs(['--catalog']);
  assert.equal(catalog.catalog, true);
  assert.deepEqual([...catalog.steps], ['brightspace']);
  assert.throws(() => parseLoginArgs(['--catalog', '--only', 'mytu']), { code: 'INVALID_ARGUMENT' });
});
