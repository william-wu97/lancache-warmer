import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createScheduler } from '../src/job/scheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a Date from local calendar fields so expectations do not depend on the
 * machine's time zone: the scheduler must use local time, as the tests do.
 *
 * @param {number} year
 * @param {number} month 1-based, like a human writes it.
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
function localTime(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test('nextRunAt returns today when the scheduled time is still ahead', () => {
  let nowMs = localTime(2026, 11, 15, 8, 0).getTime();
  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => nowMs,
    onTrigger() {},
  });

  assert.deepEqual(scheduler.nextRunAt(), localTime(2026, 11, 15, 12, 30));

  // The injected clock is read on every call, not captured once.
  nowMs = localTime(2026, 11, 15, 9, 45).getTime();
  assert.deepEqual(scheduler.nextRunAt(), localTime(2026, 11, 15, 12, 30));
});

test('nextRunAt returns tomorrow when the scheduled time has already passed', () => {
  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => localTime(2026, 11, 15, 13, 0).getTime(),
    onTrigger() {},
  });

  assert.deepEqual(scheduler.nextRunAt(), localTime(2026, 11, 16, 12, 30));
});

test('nextRunAt treats the exact scheduled instant as passed', () => {
  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => localTime(2026, 11, 15, 12, 30).getTime(),
    onTrigger() {},
  });

  assert.deepEqual(scheduler.nextRunAt(), localTime(2026, 11, 16, 12, 30));
});

test('nextRunAt rolls over into the next month', () => {
  const scheduler = createScheduler({
    hour: 1,
    minute: 0,
    now: () => localTime(2026, 1, 31, 23, 0).getTime(),
    onTrigger() {},
  });

  assert.deepEqual(scheduler.nextRunAt(), localTime(2026, 2, 1, 1, 0));
});

test('start fires at the next run time and re-arms for the following day', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const startMs = localTime(2026, 11, 15, 8, 0).getTime();
  let nowMs = startMs;
  const fires = [];

  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => nowMs,
    onTrigger: () => fires.push(new Date(nowMs)),
  });

  scheduler.start();
  // A second start while running must not register another timer.
  scheduler.start();

  const firstTarget = localTime(2026, 11, 15, 12, 30);
  nowMs = firstTarget.getTime();
  t.mock.timers.tick(firstTarget.getTime() - startMs);

  assert.deepEqual(fires, [firstTarget]);

  // After firing, the next run is recomputed from the clock for tomorrow
  // rather than assumed to be exactly 24 hours after the previous one.
  const secondTarget = localTime(2026, 11, 16, 12, 30);
  nowMs = secondTarget.getTime();
  t.mock.timers.tick(DAY_MS);

  assert.deepEqual(fires, [firstTarget, secondTarget]);
});

test('stop prevents later runs and can be called repeatedly', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const startMs = localTime(2026, 11, 15, 8, 0).getTime();
  let nowMs = startMs;
  const fires = [];

  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => nowMs,
    onTrigger: () => fires.push(new Date(nowMs)),
  });

  scheduler.start();

  const firstTarget = localTime(2026, 11, 15, 12, 30);
  nowMs = firstTarget.getTime();
  t.mock.timers.tick(firstTarget.getTime() - startMs);
  assert.equal(fires.length, 1);

  scheduler.stop();
  scheduler.stop();

  nowMs = localTime(2026, 11, 18, 12, 30).getTime();
  t.mock.timers.tick(3 * DAY_MS);

  assert.equal(fires.length, 1);
});

test('a throwing onTrigger is logged and the next day is still scheduled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));

  const startMs = localTime(2026, 11, 15, 8, 0).getTime();
  let nowMs = startMs;
  let fires = 0;

  const scheduler = createScheduler({
    hour: 12,
    minute: 30,
    now: () => nowMs,
    onTrigger() {
      fires += 1;
      throw new Error('boom');
    },
  });

  scheduler.start();

  const firstTarget = localTime(2026, 11, 15, 12, 30);
  nowMs = firstTarget.getTime();
  t.mock.timers.tick(firstTarget.getTime() - startMs);

  assert.equal(fires, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Scheduled trigger failed/);

  nowMs = localTime(2026, 11, 16, 12, 30).getTime();
  t.mock.timers.tick(DAY_MS);

  assert.equal(fires, 2);
});
