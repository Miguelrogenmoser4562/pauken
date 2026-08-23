import { describe, expect, it } from "vitest";
import {
  classColor,
  formatRange,
  isUncertain,
  monthGrid,
  monthLabel,
  isSameDay,
  startOfDay,
  startOfWeek,
  weekDays,
  weekLabel,
} from "./calendar";

describe("calendar helpers", () => {
  it("startOfDay zeroes the time", () => {
    const ms = new Date(2026, 8, 24, 18, 45).getTime();
    expect(new Date(startOfDay(ms)).getHours()).toBe(0);
    expect(startOfDay(ms)).toBe(new Date(2026, 8, 24).getTime());
  });

  it("isSameDay ignores time", () => {
    expect(
      isSameDay(
        new Date(2026, 8, 24, 23, 59).getTime(),
        new Date(2026, 8, 24, 0, 1).getTime(),
      ),
    ).toBe(true);
    expect(
      isSameDay(new Date(2026, 8, 24).getTime(), new Date(2026, 8, 25).getTime()),
    ).toBe(false);
  });

  it("monthLabel renders month and year", () => {
    expect(monthLabel(2026, 8)).toContain("September");
    expect(monthLabel(2026, 8)).toContain("2026");
  });

  it("monthGrid returns 42 cells starting on Sunday", () => {
    const cells = monthGrid(2026, 8);
    expect(cells).toHaveLength(42);
    expect(new Date(cells[0].date).getDay()).toBe(0);
    const firstInMonth = cells.find((c) => c.inMonth)!;
    expect(new Date(firstInMonth.date).getDate()).toBe(1);
    expect(new Date(firstInMonth.date).getMonth()).toBe(8);
  });

  it("monthGrid spans adjacent months and flags today", () => {
    const today = new Date(2026, 8, 15).getTime();
    const cells = monthGrid(2026, 8, today);
    expect(cells.some((c) => c.inMonth && c.isToday)).toBe(true);
    expect(cells.some((c) => !c.inMonth)).toBe(true);
  });

  it("monthGrid handles December to January rollover", () => {
    const cells = monthGrid(2026, 11);
    expect(cells.some((c) => new Date(c.date).getMonth() === 0 && !c.inMonth)).toBe(
      true,
    );
    expect(cells.some((c) => new Date(c.date).getFullYear() === 2027)).toBe(true);
  });

  it("classColor is deterministic per class id", () => {
    expect(classColor("c1")).toBe(classColor("c1"));
    expect(classColor("c1")).toMatch(/^hsl\(\d+ 75% 55%\)$/);
    expect(classColor("c1")).not.toBe(classColor("c2"));
  });

  it("startOfWeek returns the preceding Sunday at midnight", () => {
    const wed = new Date(2026, 8, 24, 15, 30).getTime();
    const sunday = startOfWeek(wed);
    expect(new Date(sunday).getDay()).toBe(0);
    expect(new Date(sunday).getDate()).toBe(20);
    expect(new Date(sunday).getHours()).toBe(0);
    expect(startOfWeek(new Date(2026, 8, 20).getTime())).toBe(
      new Date(2026, 8, 20).getTime(),
    );
  });

  it("weekDays returns 7 consecutive days starting on Sunday", () => {
    const sunday = new Date(2026, 8, 20).getTime();
    const days = weekDays(sunday);
    expect(days).toHaveLength(7);
    expect(new Date(days[0].date).getDay()).toBe(0);
    expect(new Date(days[6].date).getDate()).toBe(26);
    for (let i = 1; i < 7; i++) {
      expect(days[i].date - days[i - 1].date).toBe(86400000);
    }
  });

  it("weekDays crosses month boundaries and flags today", () => {
    const sunday = new Date(2026, 8, 27).getTime();
    const days = weekDays(sunday, new Date(2026, 9, 1, 9).getTime());
    expect(new Date(days[4].date).getMonth()).toBe(9);
    expect(days[4].isToday).toBe(true);
  });

  it("weekLabel renders the date range", () => {
    expect(weekLabel(new Date(2026, 8, 20).getTime())).toContain("20");
    expect(weekLabel(new Date(2026, 8, 20).getTime())).toContain("2026");
  });

  it("isUncertain flags ranges where the end differs from the start", () => {
    const start = new Date(2026, 8, 24).getTime();
    const end = new Date(2026, 8, 28).getTime();
    expect(isUncertain(start, undefined)).toBe(false);
    expect(isUncertain(undefined, end)).toBe(false);
    expect(isUncertain(start, start)).toBe(false);
    expect(isUncertain(start, end)).toBe(true);
  });

  it("formatRange renders the start and end of a range", () => {
    const label = formatRange(
      new Date(2026, 7, 24).getTime(),
      new Date(2026, 7, 28).getTime(),
    );
    expect(label).toContain("24");
    expect(label).toContain("28");
    expect(label).toContain("2026");
    expect(label).toMatch(/–/);
  });
});
