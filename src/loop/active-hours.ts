// ACTIVE_HOURS: local hours the loop may start iterations in, as "22-08", end
// hour excluded, wrapping past midnight. Read as base-10 numbers: bash took a
// leading zero for octal, so 08 and 09 once ended the loop every morning.

export interface Window {
  start: number;
  end: number;
}

/** The window, or an error message for the refusal. */
export function parseHours(spec: string): Window | string {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec);
  if (!m) return `ralph: ACTIVE_HOURS=${spec} is not hours like 22-08`;
  const start = Number.parseInt(m[1]!, 10);
  const end = Number.parseInt(m[2]!, 10);
  if (start > 23 || end > 23 || start === end) return `ralph: ACTIVE_HOURS=${spec} must be two different hours from 0 to 23`;
  return { start, end };
}

export function inWindow(w: Window | null, hour: number): boolean {
  if (!w) return true;
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}
