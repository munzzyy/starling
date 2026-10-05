// Check-in timer rules for the phone that sets one and every phone watching it.

// Grace for two phones whose clocks disagree.
export const DUE_GRACE_MS = 60 * 1000;
export const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DUE_WARN_MS = 5 * 60 * 1000;
export const TIMER_CHOICES_MIN = [30, 60, 120, 240, 480];
export const DEFAULT_TIMER_MIN = 60;

// A passed deadline stays: a phone still posting after it has missed it too.
export function dueFrom(obj) {
  const due = obj?.due;
  if (!Number.isFinite(due) || !Number.isFinite(obj.ts)) return null;
  return Math.abs(due - obj.ts) <= DUE_WINDOW_MS ? due : null;
}

// An ask to check in rides the asker's posts this long, and a receiver drops it after that.
export const ASK_WINDOW_MS = 15 * 60 * 1000;
export const ASK_GAP_MS = 10 * 60 * 1000;

// `ask` is the first 8 hex of the member asked, `ak` when; bounded against ts like due.
export function askFrom(obj) {
  const to = obj?.ask;
  const at = obj?.ak;
  if (typeof to !== "string" || !/^[0-9a-f]{8}$/.test(to)) return null;
  if (!Number.isSafeInteger(at) || !Number.isFinite(obj.ts)) return null;
  return Math.abs(at - obj.ts) <= ASK_WINDOW_MS ? { to, at } : null;
}

export function overdue(rec, now) {
  return !!rec?.due && now >= rec.due + DUE_GRACE_MS;
}

export function warnDue(due, now) {
  return Number.isFinite(due) && now >= due - DUE_WARN_MS && now < due;
}

// A stored timer belongs to the circle identity that armed it.
export function storedTimer(raw, memberId, now) {
  if (!raw || typeof raw !== "object") return null;
  if (!Number.isFinite(raw.due) || typeof raw.member !== "string" || !raw.member) return null;
  if (now > raw.due + DUE_WINDOW_MS) return null;
  if (memberId && raw.member !== memberId) return null;
  return { due: raw.due, member: raw.member };
}
