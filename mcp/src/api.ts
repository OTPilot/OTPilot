// The OTPilot API, as an agent (bearer token) or before it has one (pairing).
export const DEFAULT_API_URL = 'https://api.otpilot.app'

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`)
  }
}

export class Api {
  constructor(public base: string, private token?: string) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'otpilot-mcp',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as T
    if (!res.ok) throw new ApiError(res.status, json)
    return { status: res.status, body: json }
  }

  get<T>(path: string) { return this.call<T>('GET', path).then(r => r.body) }
  post<T>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}).then(r => r.body) }
}
