import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createSeederInstance } from './create-seeder-instance'
import { isSeedingActive, setSeedingActive } from './seeding-state'
import type { BaseSeederContext } from './types'

describe('integration', () => {
	beforeEach(() => {
		// Reset seeding state and silence console
		setSeedingActive(false)
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	describe('createSeederInstance', () => {
		it('should create a seeder instance with defineSeeder and runSeeders', () => {
			const { defineSeeder, runSeeders, runSeedersCli, isSeedingActive } = createSeederInstance({
				context: (base) => base,
			})

			expect(typeof defineSeeder).toBe('function')
			expect(typeof runSeeders).toBe('function')
			expect(typeof runSeedersCli).toBe('function')
			expect(typeof isSeedingActive).toBe('function')
		})

		it('should run a simple seeder', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seeder = defineSeeder({
				name: 'simpleSeeder',
				run: async () => ({ value: 42 }),
			})

			const { results, success } = await runSeeders([seeder], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(true)
			expect(results).toHaveLength(1)
			expect(results[0]?.status).toBe('completed')
			expect(results[0]?.output).toEqual({ value: 42 })
		})

		it('should provide faker, step, and expect in context', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			let contextReceived: BaseSeederContext | null = null

			const seeder = defineSeeder({
				name: 'contextSeeder',
				run: async (ctx) => {
					contextReceived = ctx
					return {}
				},
			})

			await runSeeders([seeder], { printResults: false, verbose: false })

			expect(contextReceived).not.toBeNull()
			expect(typeof contextReceived!.faker).toBe('object')
			expect(typeof contextReceived!.step).toBe('function')
			expect(typeof contextReceived!.expect).toBe('function')
		})

		it('should allow extending context', async () => {
			type CustomContext = BaseSeederContext & { customHelper: () => string }

			const { defineSeeder, runSeeders } = createSeederInstance<CustomContext>({
				context: (base) => ({
					...base,
					customHelper: () => 'custom value',
				}),
			})

			let result = ''

			const seeder = defineSeeder({
				name: 'customContextSeeder',
				run: async (ctx) => {
					result = ctx.customHelper()
					return {}
				},
			})

			await runSeeders([seeder], { printResults: false, verbose: false })

			expect(result).toBe('custom value')
		})

		it('should pass dependencies between seeders', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => ({ userId: 'user-123' }),
			})

			const seederB = defineSeeder({
				name: 'seederB',
				dependsOn: [seederA],
				run: async (_ctx, deps) => {
					return { postAuthor: deps.seederA.userId }
				},
			})

			const { results, success } = await runSeeders([seederB, seederA], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(true)
			expect(results).toHaveLength(2)

			const seederBResult = results.find((r) => r.name === 'seederB')
			expect(seederBResult?.output).toEqual({ postAuthor: 'user-123' })
		})

		it('should set seeding state during execution', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const statesDuringRun: boolean[] = []

			const seeder = defineSeeder({
				name: 'stateSeeder',
				run: async () => {
					statesDuringRun.push(isSeedingActive())
					return {}
				},
			})

			expect(isSeedingActive()).toBe(false)
			await runSeeders([seeder], { printResults: false, verbose: false })
			expect(isSeedingActive()).toBe(false)
			expect(statesDuringRun).toEqual([true])
		})

		it('should call onBeforeAll and onAfterAll hooks', async () => {
			const beforeAll = mock(async () => {})
			const afterAll = mock(async () => {})

			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				onBeforeAll: beforeAll,
				onAfterAll: afterAll,
			})

			const seeder = defineSeeder({
				name: 'hookSeeder',
				run: async () => ({}),
			})

			await runSeeders([seeder], { printResults: false, verbose: false })

			expect(beforeAll).toHaveBeenCalledTimes(1)
			expect(afterAll).toHaveBeenCalledTimes(1)
		})

		it('should handle seeder failure', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seeder = defineSeeder({
				name: 'failingSeeder',
				run: async () => {
					throw new Error('Seeder failed!')
				},
			})

			const { results, success } = await runSeeders([seeder], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(false)
			expect(results).toHaveLength(1)
			expect(results[0]?.status).toBe('failed')
			expect(results[0]?.error?.message).toBe('Seeder failed!')
		})

		it('should stop on failure by default', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(false)
			expect(results[0]?.status).toBe('failed')
			expect(results[1]?.status).toBe('pending') // Never ran
		})

		it('should continue on failure when continueOnFailure is true', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB], {
				printResults: false,
				verbose: false,
				continueOnFailure: true,
			})

			expect(success).toBe(false)
			expect(results[0]?.status).toBe('failed')
			expect(results[1]?.status).toBe('completed') // Ran despite seederA failing
		})

		it('should skip dependents of failed seeders when continueOnFailure is true', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				dependsOn: [seederA],
				run: async () => ({ ran: true }),
			})

			const seederC = defineSeeder({
				name: 'seederC',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB, seederC], {
				printResults: false,
				verbose: false,
				continueOnFailure: true,
			})

			expect(success).toBe(false)
			expect(results.find((r) => r.name === 'seederA')?.status).toBe('failed')
			expect(results.find((r) => r.name === 'seederB')?.status).toBe('skipped')
			expect(results.find((r) => r.name === 'seederC')?.status).toBe('completed')
		})
	})
})
