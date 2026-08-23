/**
 * Weekly trigger schedules — the arithmetic behind "every Monday at 09:00".
 *
 * The interesting cases are all about time NOT being uniform: a slot that has
 * already passed today, a slot missed while the machine slept, and a week that
 * is not 7 * 24h long because the clocks moved. The last one is why the module
 * builds instants from calendar fields instead of adding milliseconds, and it
 * is asserted here in a fixed zone so the test means the same thing everywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  normalizeWeekly, formatWeekly, formatMinute,
  nextWeeklyFireMs, previousWeeklyFireMs, weeklyDelayMs, WEEKLY_CATCHUP_MS
} = loadTs('src/shared/weeklySchedule.ts');

/** Local-time helper: these tests run under TZ=UTC (set below), so a local
 *  construction and a UTC one agree except in the DST block, which sets its own. */
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

test('normalizeWeekly sorts, de-dupes and rejects nonsense', () => {
  assert.deepEqual(normalizeWeekly({ days: [4, 1, 1], minute: 540 }), { days: [1, 4], minute: 540 });
  assert.equal(normalizeWeekly({ days: [], minute: 540 }), null, 'no days is not a schedule');
  assert.equal(normalizeWeekly({ days: [7], minute: 540 }), null, 'day 7 does not exist');
  assert.equal(normalizeWeekly({ days: [1], minute: 1440 }), null, 'minute 1440 is tomorrow');
  assert.equal(normalizeWeekly({ days: [1], minute: -1 }), null);
  assert.equal(normalizeWeekly({ days: [1], minute: 9.5 }), null, 'fractional minutes are a bug upstream');
  assert.equal(normalizeWeekly(undefined), null);
  assert.equal(normalizeWeekly({ days: [1] }), null, 'a day with no time is not a schedule');
});

test('formatWeekly names the common sets rather than listing them', () => {
  assert.equal(formatWeekly({ days: [0, 1, 2, 3, 4, 5, 6], minute: 540 }), 'every day at 09:00');
  assert.equal(formatWeekly({ days: [1, 2, 3, 4, 5], minute: 540 }), 'weekdays at 09:00');
  assert.equal(formatWeekly({ days: [0, 6], minute: 630 }), 'weekends at 10:30');
  assert.equal(formatWeekly({ days: [1, 4], minute: 870 }), 'Mon, Thu at 14:30');
  assert.equal(formatWeekly({ days: [], minute: 0 }), 'no days picked');
  assert.equal(formatMinute(0), '00:00');
  assert.equal(formatMinute(1439), '23:59');
});

test('nextWeeklyFireMs skips today once the slot has passed', () => {
  const mondays = { days: [1], minute: 540 }; // Mon 09:00
  // 2026-08-24 is a Monday.
  assert.equal(nextWeeklyFireMs(mondays, at(2026, 8, 24, 8, 0)), at(2026, 8, 24, 9, 0), 'later today');
  assert.equal(nextWeeklyFireMs(mondays, at(2026, 8, 24, 9, 0)), at(2026, 8, 31, 9, 0),
    'exactly on the slot means it is spent — strictly after, or a re-arm double-fires');
  assert.equal(nextWeeklyFireMs(mondays, at(2026, 8, 24, 10, 0)), at(2026, 8, 31, 9, 0), 'next week');
  assert.equal(nextWeeklyFireMs({ days: [], minute: 540 }, Date.now()), null);
});

test('nextWeeklyFireMs picks the nearest of several days', () => {
  const mwf = { days: [1, 3, 5], minute: 540 };
  assert.equal(nextWeeklyFireMs(mwf, at(2026, 8, 24, 10, 0)), at(2026, 8, 26, 9, 0), 'Mon 10:00 -> Wed');
  assert.equal(nextWeeklyFireMs(mwf, at(2026, 8, 26, 10, 0)), at(2026, 8, 28, 9, 0), 'Wed -> Fri');
  assert.equal(nextWeeklyFireMs(mwf, at(2026, 8, 28, 10, 0)), at(2026, 8, 31, 9, 0), 'Fri -> Mon, over the weekend');
});

test('previousWeeklyFireMs finds the slot behind us', () => {
  const mondays = { days: [1], minute: 540 };
  assert.equal(previousWeeklyFireMs(mondays, at(2026, 8, 24, 10, 0)), at(2026, 8, 24, 9, 0));
  assert.equal(previousWeeklyFireMs(mondays, at(2026, 8, 24, 8, 0)), at(2026, 8, 17, 9, 0), 'last week');
});

test('a slot missed while asleep fires on wake, once, and only if recent', () => {
  const mondays = { days: [1], minute: 540 };
  const slot = at(2026, 8, 24, 9, 0);

  // Woke at 10:00 having never run it: catch up.
  assert.equal(weeklyDelayMs(mondays, at(2026, 8, 24, 10, 0), 0), 0);

  // Same wake, but it already ran at 09:00. This is the re-arm case — the
  // scheduler rebuilds every timer whenever ANY mission is saved — and firing
  // again here would double-dispatch every edit.
  assert.equal(weeklyDelayMs(mondays, at(2026, 8, 24, 10, 0), slot), at(2026, 8, 31, 9, 0) - at(2026, 8, 24, 10, 0));

  // Woke well past the catch-up window: the 09:00 run is gone, not deferred to
  // an hour nobody asked for.
  const late = slot + WEEKLY_CATCHUP_MS + 60_000;
  assert.equal(weeklyDelayMs(mondays, late, 0), at(2026, 8, 31, 9, 0) - late);
});

test('weeklyDelayMs waits, rather than firing, when the slot is ahead', () => {
  const mondays = { days: [1], minute: 540 };
  const now = at(2026, 8, 24, 8, 0);
  assert.equal(weeklyDelayMs(mondays, now, 0), 60 * 60 * 1000, 'one hour to go');
  assert.equal(weeklyDelayMs({ days: [], minute: 540 }, now, 0), null);
});

test('every delay fits in a setTimeout', () => {
  // Node clamps a timeout above 2^31-1 ms and fires it IMMEDIATELY, which would
  // turn a long gap into a hot loop. One day a week is the longest possible gap.
  const sundays = { days: [0], minute: 0 };
  const d = weeklyDelayMs(sundays, at(2026, 8, 24, 0, 1), Date.now());
  assert.ok(d !== null && d <= 7 * 86400000 && d < 2147483647);
});

test('the clocks moving does not move the appointment', () => {
  // US DST ends 2026-11-01, so the week containing it is 169 hours long, not
  // 168. A Monday 09:00 schedule must stay at 09:00 on both sides of it — which
  // is exactly what adding 7 * 86400000 ms would fail to do.
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const slot = new Date(2026, 9, 26, 9, 0, 0, 0).getTime(); // Mon 26 Oct, 09:00 EDT
    const fire = nextWeeklyFireMs({ days: [1], minute: 540 }, slot + 1000);
    const landed = new Date(fire);
    assert.equal(landed.getDate(), 2, 'lands on Monday 2 November');
    assert.equal(landed.getMonth(), 10);
    assert.equal(landed.getHours(), 9, 'still 09:00 local, not 08:00');
    // The proof that this is calendar arithmetic and not millisecond arithmetic:
    // the gap between two consecutive 09:00 Mondays across the fall-back is a
    // week PLUS the repeated hour.
    assert.equal(fire - slot, 7 * 86400000 + 60 * 60 * 1000);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
