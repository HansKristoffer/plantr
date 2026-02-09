import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createStepRunner, type SeederCache } from './step'

describe('createStepRunner', () => {
	beforeEach(() => {
		// Silence console output during tests
		spyOn(console, 'log').mockImplementation(() => {})
	})

	describe('basic step execution', () => {
		it('should execute step and return result', async () => {
			const { step } = createStepRunner()
			const result = await step('Test step', () => 42)
			expect(result).toBe(42)
		})

		it('should execute async step and return result', async () => {
			const { step } = createStepRunner()
			const result = await step('Async step', async () => {
				await new Promise((r) => setTimeout(r, 10))
				return 'async result'
			})
			expect(result).toBe('async result')
		})

		it('should propagate errors from step', async () => {
			const { step } = createStepRunner()
			await expect(
				step('Failing step', () => {
					throw new Error('Step failed')
				}),
			).rejects.toThrow('Step failed')
		})

		it('should propagate async errors from step', async () => {
			const { step } = createStepRunner()
			await expect(
				step('Async failing step', async () => {
					throw new Error('Async step failed')
				}),
			).rejects.toThrow('Async step failed')
		})
	})

	describe('setSeederName', () => {
		it('should set seeder name for cache key scoping', async () => {
			const cache: SeederCache = {
				get: mock(async () => undefined),
				set: mock(async () => {}),
			}

			const { step, setSeederName } = createStepRunner({ cache })
			setSeederName('mySeeder')

			await step('Create item', () => 'result', { useCache: true })

			// Verify cache.set was called with scoped key
			expect(cache.set).toHaveBeenCalledWith('mySeeder:create-item', 'result')
		})
	})

	describe('caching', () => {
		it('should cache result when useCache is true', async () => {
			const cacheStore = new Map<string, unknown>()
			let getCalls = 0
			let setCalls = 0
			const cache: SeederCache = {
				get: async <T>(key: string) => {
					getCalls++
					return cacheStore.get(key) as T | undefined
				},
				set: async <T>(key: string, value: T) => {
					setCalls++
					cacheStore.set(key, value)
				},
			}

			const { step, setSeederName } = createStepRunner({ cache })
			setSeederName('testSeeder')

			// First call - should execute and cache
			const fn = mock(() => 'computed value')
			const result1 = await step('Cached step', fn, { useCache: true })

			expect(result1).toBe('computed value')
			expect(fn).toHaveBeenCalledTimes(1)
			expect(setCalls).toBe(1)

			// Second call - should return cached value
			const result2 = await step('Cached step', fn, { useCache: true })

			expect(result2).toBe('computed value')
			expect(fn).toHaveBeenCalledTimes(1) // Still 1 - not called again
			expect(getCalls).toBe(2) // Once for first call (miss), once for second (hit)
		})

		it('should not cache when useCache is false (default)', async () => {
			const cache: SeederCache = {
				get: mock(async () => undefined),
				set: mock(async () => {}),
			}

			const { step } = createStepRunner({ cache })
			await step('Non-cached step', () => 'result')

			expect(cache.get).not.toHaveBeenCalled()
			expect(cache.set).not.toHaveBeenCalled()
		})

		it('should warn when useCache is true but no cache configured', async () => {
			const consoleSpy = spyOn(console, 'log')
			const { step } = createStepRunner() // No cache

			await step('Step without cache', () => 'result', { useCache: true })

			expect(consoleSpy).toHaveBeenCalled()
			// Check that warning was logged (contains 'Cache not configured')
			const calls = consoleSpy.mock.calls.flat()
			expect(calls.some((c) => String(c).includes('Cache not configured'))).toBe(true)
		})

		it('should scope cache keys by seeder name', async () => {
			const cacheStore = new Map<string, unknown>()
			const cache: SeederCache = {
				get: async <T>(key: string) => cacheStore.get(key) as T | undefined,
				set: async <T>(key: string, value: T) => {
					cacheStore.set(key, value)
				},
			}

			const { step, setSeederName } = createStepRunner({ cache })

			// Set first seeder name and cache
			setSeederName('seederA')
			await step('Create user', () => 'user-a', { useCache: true })

			// Set second seeder name and cache same step name
			setSeederName('seederB')
			await step('Create user', () => 'user-b', { useCache: true })

			// Verify both are cached separately
			expect(cacheStore.get('seederA:create-user')).toBe('user-a')
			expect(cacheStore.get('seederB:create-user')).toBe('user-b')
		})
	})
})
