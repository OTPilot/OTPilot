import { createRequire } from 'node:module'
// The OTPilot API, as an agent (bearer token) or before it has one (pairing).
export const DEFAULT_API_URL = 'https://api.otpilot.app'

// From package.json, so --version, the MCP handshake and the API header always match the release.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version

/** Sent on every call: the API knows this MCP opens copies with POST /agent/grants/open. */
export const MCP_HEADER = 'x-otpilot-mcp'

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`)
  }

  /** The API's machine-readable error code (agent_uses_exhausted, mcp_outdated, not_granted…), if any. */
  get code(): string | undefined {
    const b = this.body as { code?: unknown } | null
    return typeof b?.code === 'string' ? b.code : undefined
  }
}

export class Api {
  constructor(public base: string, private token?: string) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base.replace(/\/$/, '')}${path}`, {
      method,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'otpilot-mcp',
        [MCP_HEADER]: VERSION,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as T
    if (!res.ok) throw new ApiError(res.status, json)
    return { status: res.status, body: json }
  }

  get<T>(path: string, timeoutMs?: number) { return this.call<T>('GET', path, undefined, timeoutMs).then(r => r.body) }
  post<T>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}).then(r => r.body) }
}
