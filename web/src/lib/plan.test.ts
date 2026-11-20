import { describe, expect, it } from 'vitest'
import { trialCarriesOver, trialDaysLeft, trialOfferOpen } from './plan'

const now = Date.parse('2026-10-19T12:00:00Z')
const inHours = (h: number) => new Date(now + h * 3600e3).toISOString()

describe('trial', () => {
  it('counts the days left rounded up, never below zero', () => {
    expect(trialDaysLeft(inHours(50), now)).toBe(3)
    expect(trialDaysLeft(inHours(72), now)).toBe(3)
    expect(trialDaysLeft(inHours(2), now)).toBe(1)
    expect(trialDaysLeft(inHours(-5), now)).toBe(0)
    // A clock a few seconds behind the server's, on the trial's first day.
    expect(trialDaysLeft(inHours(30 * 24 + 0.01), now)).toBe(30)
  })

  it('carries the trial over to a subscription only with 49 h or more left (Stripe needs 48)', () => {
    expect(trialCarriesOver(inHours(12 * 24), now)).toBe(true)
    expect(trialCarriesOver(inHours(49), now)).toBe(true)
    expect(trialCarriesOver(inHours(30), now)).toBe(false)
    expect(trialCarriesOver(null, now)).toBe(false)
  })
})

describe('trialOfferOpen', () => {
  const at = Date.parse('2026-03-01T00:00:00Z')
  it('is open until its end only', () => {
    expect(trialOfferOpen('2026-03-02T00:00:00Z', at)).toBe(true)
    expect(trialOfferOpen('2026-02-28T00:00:00Z', at)).toBe(false)
    expect(trialOfferOpen(null, at)).toBe(false)
    expect(trialOfferOpen(undefined, at)).toBe(false)
  })
})
