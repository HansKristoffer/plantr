import { beforeEach, describe, expect, it } from 'bun:test'
import { enterSeeding, exitSeeding, isSeedingActive, setSeedingActive } from './seeding-state.js'

describe('seeding-state', () => {
	beforeEach(() => {
		// Reset state before each test
		setSeedingActive(false)
	})

	it('should default to false', () => {
		expect(isSeedingActive()).toBe(false)
	})

	it('should return true after setting to true', () => {
		setSeedingActive(true)
		expect(isSeedingActive()).toBe(true)
	})

	it('should return false after setting to false', () => {
		setSeedingActive(true)
		setSeedingActive(false)
		expect(isSeedingActive()).toBe(false)
	})

	it('should persist state across multiple calls', () => {
		expect(isSeedingActive()).toBe(false)
		setSeedingActive(true)
		expect(isSeedingActive()).toBe(true)
		expect(isSeedingActive()).toBe(true) // Still true
		setSeedingActive(false)
		expect(isSeedingActive()).toBe(false)
	})

	it('should reference-count overlapping seeding runs', () => {
		expect(isSeedingActive()).toBe(false)
		enterSeeding()
		enterSeeding()
		expect(isSeedingActive()).toBe(true)
		exitSeeding()
		expect(isSeedingActive()).toBe(true) // One run still active
		exitSeeding()
		expect(isSeedingActive()).toBe(false)
		// Extra exit does not underflow
		exitSeeding()
		expect(isSeedingActive()).toBe(false)
	})
})
