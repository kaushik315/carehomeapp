export function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function weekKey(d: Date): string {
  const m = mondayOf(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
}

export function ddmm(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function shiftHours(s: { start: string; end: string }): number {
  let l = toMin(s.end) - toMin(s.start);
  if (l <= 0) l += 1440;
  return l / 60;
}

export function shortTime(t: string): string {
  return t.endsWith(":00") ? t.slice(0, 2) : t;
}

export function shiftLabel(s: { start: string; end: string }): string {
  return `${shortTime(s.start)}–${shortTime(s.end)}`;
}
