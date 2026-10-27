import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { calendarDaysBetween, formatDateSeparator, formatMessageTime, getDateKey } from '@/app/utils/dates';

/* Clock changes only exist in a zone with daylight saving, so these tests pin the process to London and restore it after */
beforeAll(() => {
  vi.stubEnv('TZ', 'Europe/London');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('calendarDaysBetween', () => {
  it('counts the 23-hour day when the clocks go forward as one day', () => {
    const sunday = new Date('2026-03-29T00:00:00Z');
    const monday = new Date('2026-03-30T00:00:00+01:00');

    expect(calendarDaysBetween(sunday, monday)).toBe(1);
  });

  it('counts the 25-hour day when the clocks go back as one day', () => {
    const sunday = new Date('2026-10-25T00:00:00+01:00');
    const monday = new Date('2026-10-26T00:00:00Z');

    expect(calendarDaysBetween(sunday, monday)).toBe(1);
  });

  it('counts late evening to early morning of the next day as one day', () => {
    expect(calendarDaysBetween(new Date('2026-06-11T23:59:00+01:00'), new Date('2026-06-12T00:01:00+01:00'))).toBe(1);
  });

  it('counts the same calendar day as zero', () => {
    expect(calendarDaysBetween(new Date('2026-06-12T00:01:00+01:00'), new Date('2026-06-12T23:59:00+01:00'))).toBe(0);
  });
});

describe('formatDateSeparator', () => {
  const monday = new Date('2026-03-30T12:00:00+01:00');

  it('labels the days across the clocks going forward as a weekday, Yesterday and Today', () => {
    const saturday = new Date('2026-03-28T12:00:00Z').getTime();
    const sunday = new Date('2026-03-29T12:00:00+01:00').getTime();
    const mondayMorning = new Date('2026-03-30T09:00:00+01:00').getTime();

    expect([saturday, sunday, mondayMorning].map((ts) => formatDateSeparator(ts, monday))).toEqual([
      new Date(saturday).toLocaleDateString(undefined, { weekday: 'long' }),
      'Yesterday',
      'Today',
    ]);
  });

  it('names the weekday up to six days back and the date from a week back', () => {
    const sixDaysBack = new Date('2026-03-24T12:00:00Z').getTime();
    const aWeekBack = new Date('2026-03-23T12:00:00Z').getTime();

    expect(formatDateSeparator(sixDaysBack, monday)).toBe(new Date(sixDaysBack).toLocaleDateString(undefined, { weekday: 'long' }));
    expect(formatDateSeparator(aWeekBack, monday)).toBe(new Date(aWeekBack).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }));
  });

  it('names the month and day for an older date this year', () => {
    const older = new Date('2026-02-01T10:00:00Z').getTime();

    expect(formatDateSeparator(older, monday)).toBe(new Date(older).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }));
  });

  it('adds the year for a date in an earlier year', () => {
    const lastYear = new Date('2025-12-24T10:00:00Z').getTime();

    expect(formatDateSeparator(lastYear, monday)).toBe(
      new Date(lastYear).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    );
  });
});

describe('getDateKey', () => {
  it('keys a timestamp by its local calendar date', () => {
    expect(getDateKey(new Date('2026-03-29T23:30:00Z').getTime())).toBe('2026-03-30');
  });
});

describe('formatMessageTime', () => {
  it('shows the local hour and minute without seconds', () => {
    const time = formatMessageTime(new Date('2026-06-12T08:05:42Z').getTime());

    expect(time).toMatch(/^0?9:05\b/);
    expect(time).not.toContain('42');
  });
});