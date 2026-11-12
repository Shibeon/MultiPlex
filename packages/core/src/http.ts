export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
  ) {
    // La query string est retirée : elle peut contenir le jeton.
    super(`HTTP ${status} ${url.split('?')[0]}`);
  }
}

/** Le serveur n'a pas répondu à temps. */
export class TimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`Le serveur n'a pas répondu en ${Math.round(ms / 1000)} s (${url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')})`);
    this.name = 'TimeoutError';
  }
}

export type RequestOptions = RequestInit & { timeout?: number };

export async function request(url: string, init: RequestOptions = {}): Promise<Response> {
  const { timeout = 15000, signal, ...rest } = init;
  const ctl = new AbortController();
  // Avec une raison lisible : sans elle, Chrome affiche « signal is aborted without reason ».
  const timer = setTimeout(() => ctl.abort(new TimeoutError(url, timeout)), timeout);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, { ...rest, signal: ctl.signal });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, init: RequestOptions = {}): Promise<T> {
  const res = await request(url, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  return (await res.json()) as T;
}

export function randomId(len = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
