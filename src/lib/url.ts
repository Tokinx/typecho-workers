export function normalizeHttpUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return '';

  // Quotes and angle brackets have no valid unencoded role in an HTTP URL.
  // Reject them before parsing so legacy attribute rendering stays safe.
  if (/["'<>\u0000-\u001F\u007F]/.test(raw)) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
