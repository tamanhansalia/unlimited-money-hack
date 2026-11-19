export function duration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 1h 12m / 4m 05s / 42s */
export function durationLong(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value >= 1073741824) return (value / 1073741824).toFixed(1) + ' GB';
  if (value >= 1048576) return (value / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.ceil(value / 1024)) + ' KB';
}

export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, now - ms) / 1000;
  if (seconds < 45) return 'Just now';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  if (seconds < 86400 * 7) return Math.round(seconds / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export const plural = (count, one, many = one + 's') => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** m:ss for an elapsed millisecond span */
export function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

export const baseName = path => String(path || '').split(/[\\/]/).pop();
