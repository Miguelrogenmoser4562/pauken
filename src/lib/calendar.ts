/* Pure month-grid helpers for the Calendar page. All dates are epoch ms at
   local midnight. */

export interface MonthCell {
  date: number;
  inMonth: boolean;
  isToday: boolean;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* Deterministic per-class color derived from the class id. Stable across
   sessions so a class always keeps its hue; no persistence needed. */
export function classColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 75% 55%)`;
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/* True when a dated item is a range, so `date` is just the start of it
   (the exact date is unknown and the user should fix it). */
export function isUncertain(
  date: number | undefined,
  dateEnd: number | undefined,
): boolean {
  return date !== undefined && dateEnd !== undefined && dateEnd !== date;
}

/* "Aug 24 – 28, 2026" style label for a start/end range. */
export function formatRange(startMs: number, endMs: number): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const sLabel = s.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const eLabel = e.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${sLabel} – ${eLabel}`;
}

/* Local-midnight Sunday of the week containing the given date. */
export function startOfWeek(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
}

/* 7 cells covering the week that starts on the given Sunday. */
export function weekDays(sundayMs: number, today: number = Date.now()): MonthCell[] {
  const start = startOfDay(sundayMs);
  const d = new Date(start);
  const cells: MonthCell[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    const date = day.getTime();
    cells.push({ date, inMonth: true, isToday: isSameDay(date, today) });
  }
  return cells;
}

/* "Aug 17 – 23, 2026" style range label for the week starting at sundayMs. */
export function weekLabel(sundayMs: number): string {
  const start = new Date(startOfDay(sundayMs));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const s = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const e = end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${s} – ${e}`;
}

/* 42-cell (6x7) grid covering the given month, Sunday-first, with leading and
   trailing days drawn from adjacent months. */
export function monthGrid(
  year: number,
  month: number,
  today: number = Date.now(),
): MonthCell[] {
  const first = new Date(year, month, 1);
  const offset = first.getDay();
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - offset + i);
    const date = d.getTime();
    cells.push({
      date,
      inMonth: d.getMonth() === month,
      isToday: isSameDay(date, today),
    });
  }
  return cells;
}
