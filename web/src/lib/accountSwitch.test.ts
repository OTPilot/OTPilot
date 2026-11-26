import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { noteAccount } from './accountSwitch'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// A page's query, observed like useQuery does, with its answer still pending.
function observe(client: QueryClient, key: string, answer: Promise<unknown>) {
  const observer = new QueryObserver(client, { queryKey: [key], queryFn: () => answer })
  const seen: { status: string; data: unknown }[] = []
  const unsubscribe = observer.subscribe((r) => seen.push({ status: r.status, data: r.data }))
  return { observer, seen, unsubscribe }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('noteAccount', () => {
  it('the first account to arrive keeps the queries in flight (Billing from the offer email)', async () => {
    const client = new QueryClient()
    const onAccount = (id: string | null | undefined) => noteAccount(client, id)
    const answer = deferred<{ plan: string }>()
    const page = observe(client, 'user-plan', answer.promise)

    onAccount('user-a')
    answer.resolve({ plan: 'free' })
    await settle()

    expect(page.observer.getCurrentResult().status).toBe('success')
    expect(page.observer.getCurrentResult().data).toEqual({ plan: 'free' })
    page.unsubscribe()
  })

  it('what clear() did on the first arrival: the page never hears the answer', async () => {
    // Guards the reason for the guard: if React Query stops cancelling
    // silently, this test tells us the workaround is no longer needed.
    const client = new QueryClient()
    const answer = deferred<{ plan: string }>()
    const page = observe(client, 'user-plan', answer.promise)

    client.clear()
    answer.resolve({ plan: 'free' })
    await settle()

    expect(page.observer.getCurrentResult().status).toBe('pending')
    page.unsubscribe()
  })

  it('the same account again (token refresh, signed-out blip) keeps the cache', () => {
    const client = new QueryClient()
    const onAccount = (id: string | null | undefined) => noteAccount(client, id)
    onAccount('user-a')
    client.setQueryData(['user-plan'], { plan: 'personal' })

    onAccount('user-a')
    onAccount(null)
    onAccount(undefined)
    onAccount('user-a')

    expect(client.getQueryData(['user-plan'])).toEqual({ plan: 'personal' })
  })

  it('another account drops the previous one\'s data', () => {
    const client = new QueryClient()
    const onAccount = (id: string | null | undefined) => noteAccount(client, id)
    onAccount('user-a')
    client.setQueryData(['user-plan'], { plan: 'team_lite' })
    client.setQueryData(['team'], { owner_id: 'user-a' })

    onAccount('user-b')

    expect(client.getQueryData(['user-plan'])).toBeUndefined()
    expect(client.getQueryData(['team'])).toBeUndefined()
  })

  it('another account after a sign-out in between still drops it', () => {
    const client = new QueryClient()
    const onAccount = (id: string | null | undefined) => noteAccount(client, id)
    onAccount('user-a')
    client.setQueryData(['user-plan'], { plan: 'team_lite' })

    onAccount(null)
    onAccount('user-b')

    expect(client.getQueryData(['user-plan'])).toBeUndefined()
  })

  it('remembers the account with the client, across the layout unmounting (Back after a sign-out elsewhere)', () => {
    const client = new QueryClient()
    // Account A's dashboard: the layout reports A, pages cache A's data.
    noteAccount(client, 'user-a')
    client.setQueryData(['devices'], [{ name: "A's laptop" }])

    // Signed out in another tab: the layout unmounts (login redirect) and is
    // mounted again later, B signed in. Nothing of the first mount is left
    // but the client.
    noteAccount(client, null)
    noteAccount(client, 'user-b')

    expect(client.getQueryData(['devices'])).toBeUndefined()
  })

  it('each client has its own account', () => {
    const one = new QueryClient()
    const two = new QueryClient()
    noteAccount(one, 'user-a')
    two.setQueryData(['user-plan'], { plan: 'free' })

    noteAccount(two, 'user-b')

    expect(two.getQueryData(['user-plan'])).toEqual({ plan: 'free' })
  })
})
