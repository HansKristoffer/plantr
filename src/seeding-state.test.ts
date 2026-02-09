import { beforeEach, describe, expect, it } from 'bun:test'
import { isSeedingActive, setSeedingActive } from './seeding-state'

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
})
