const MS_PER_DAY = 86_400_000;

/* Numbers local calendar days through a UTC epoch count, so subtracting two of them gives whole days even across a 23- or 25-hour day */
const localDayNumber = (date: Date): number =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;

/* Whole local calendar days from one date to another, positive when the second date is later */
export const calendarDaysBetween = (from: Date, to: Date): number => localDayNumber(to) - localDayNumber(from);

export const getDateKey = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const formatDateSeparator = (timestamp: number, now: Date = new Date()): string => {
  const date = new Date(timestamp);
  const diffDays = calendarDaysBetween(date, now);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

export const formatMessageTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });