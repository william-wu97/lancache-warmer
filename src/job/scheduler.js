/**
 * Daily scheduler.
 *
 * The scheduler only owns the timing: once per day it calls the supplied
 * `onTrigger` callback and lets the caller decide what a prefill actually does.
 * Only a single `setTimeout` is ever pending; after it fires the next run time
 * is recomputed from the clock. That keeps the schedule anchored to local wall
 * time when a timer fires late (system sleep, clock change) instead of drifting
 * by a fixed 24 hours.
 */

/**
 * @typedef {Object} SchedulerOptions
 * @property {number} hour Local hour of day (0-23).
 * @property {number} minute Local minute of hour (0-59).
 * @property {() => unknown} onTrigger Called once per day. A thrown error or
 *   rejected promise is logged and does not stop later runs.
 * @property {() => number} [now] Clock returning Unix time in milliseconds.
 *   Defaults to `Date.now`; tests inject a fake clock.
 */

/**
 * @typedef {Object} Scheduler
 * @property {() => void} start Arm the timer. Calling it again while running
 *   is a no-op.
 * @property {() => void} stop Disarm the timer. Safe to call repeatedly.
 * @property {() => Date} nextRunAt Next local run time, or tomorrow when
 *   today's time has already passed.
 */

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {asserts value is number}
 */
function assertIntegerInRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer between ${min} and ${max}, got ${String(value)}`,
    );
  }
}

/**
 * Create a scheduler that fires `onTrigger` once a day at `hour:minute` in the
 * system's local time zone.
 *
 * @param {SchedulerOptions} opts
 * @returns {Scheduler}
 */
export function createScheduler(opts) {
  const { hour, minute, onTrigger, now = Date.now } = opts ?? {};

  assertIntegerInRange('hour', hour, 0, 23);
  assertIntegerInRange('minute', minute, 0, 59);

  if (typeof onTrigger !== 'function') {
    throw new TypeError('onTrigger must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let running = false;

  /** @returns {number} */
  function currentTime() {
    return Number(now());
  }

  /**
   * Today's configured local time, or tomorrow's when it is not strictly in
   * the future. Local date construction avoids any manual UTC offset
   * arithmetic, so daylight-saving transitions are handled by `Date`.
   *
   * @returns {Date}
   */
  function nextRunAt() {
    const currentMs = currentTime();
    const current = new Date(currentMs);
    const next = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      hour,
      minute,
      0,
      0,
    );

    if (next.getTime() <= currentMs) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    // Drop any timer registered by a re-entrant start() from onTrigger so only
    // one run can ever be pending.
    clearTimer();

    if (!running) {
      return;
    }

    const delay = Math.max(0, nextRunAt().getTime() - currentTime());
    timer = setTimeout(fire, delay);
  }

  function fire() {
    timer = null;

    if (!running) {
      return;
    }

    try {
      const result = onTrigger();
      // A rejected async callback would otherwise surface as an unhandled
      // rejection. The next run is scheduled either way.
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(undefined, (error) => {
          console.error('Scheduled trigger failed:', error);
        });
      }
    } catch (error) {
      console.error('Scheduled trigger failed:', error);
    }

    scheduleNext();
  }

  function start() {
    if (running) {
      return;
    }

    running = true;
    scheduleNext();
  }

  function stop() {
    running = false;
    clearTimer();
  }

  return { start, stop, nextRunAt };
}
