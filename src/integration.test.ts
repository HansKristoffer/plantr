import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { runCli } from './cli'
import { createSeederInstance } from './create-seeder-instance'
import { MissingDependencyError, UnknownSeederError } from './dependency-resolver'
import { describeTarget, SeedTargetError } from './run-seeders'
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

	describe('validation and safety', () => {
		const memoryCache = () => {
			const store = new Map<string, unknown>()
			return {
				store,
				cache: {
					get: async <T>(key: string) => store.get(key) as T | undefined,
					set: async <T>(key: string, value: T) => {
						store.set(key, value)
					},
				},
			}
		}

		it('should throw on a missing dependency before any hook runs', async () => {
			const beforeAll = mock(async () => {})
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				onBeforeAll: beforeAll,
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			await expect(
				runSeeders([{ ...seeder, dependsOn: ['ghost'] }], { verbose: false }),
			).rejects.toThrow(MissingDependencyError)
			expect(beforeAll).not.toHaveBeenCalled()
			expect(isSeedingActive()).toBe(false)
		})

		it('should clear the seeding flag when onBeforeAll throws', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				onBeforeAll: () => {
					throw new Error('cannot connect')
				},
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			await expect(runSeeders([seeder], { verbose: false })).rejects.toThrow('cannot connect')
			expect(isSeedingActive()).toBe(false)
		})

		it('should call onBeforeAll before the context factory', async () => {
			const calls: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => {
					calls.push('context')
					return base
				},
				onBeforeAll: () => {
					calls.push('onBeforeAll')
				},
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			await runSeeders([seeder], { verbose: false, printResults: false })
			expect(calls).toEqual(['onBeforeAll', 'context'])
		})

		it('should refuse a remote target unless allowRemote is set', async () => {
			const context = mock((base: BaseSeederContext) => base)
			const { defineSeeder, runSeeders } = createSeederInstance({
				context,
				target: () => 'postgresql://admin:secret@db.example.com:5432/app',
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			const refused = runSeeders([seeder], { verbose: false })
			await expect(refused).rejects.toThrow(SeedTargetError)
			await expect(refused).rejects.toThrow('db.example.com:5432/app')
			expect(context).not.toHaveBeenCalled()

			const { success } = await runSeeders([seeder], {
				verbose: false,
				printResults: false,
				allowRemote: true,
			})
			expect(success).toBe(true)
		})

		it('should describe targets without credentials', () => {
			expect(describeTarget('postgresql://u:pw@localhost:5432/hugsi')).toEqual({
				label: 'localhost:5432/hugsi',
				local: true,
			})
			expect(describeTarget('postgresql://u:pw@postgres:5432/app').local).toBe(true)
			expect(describeTarget('postgresql://u@127.0.0.1/app').local).toBe(true)
			expect(describeTarget('postgresql://u@[::1]:5432/app').local).toBe(true)
			expect(describeTarget('postgresql://u@host.docker.internal/app').local).toBe(true)
			expect(describeTarget('postgresql://u@postgres.railway.internal/app').local).toBe(false)
			expect(describeTarget('not a url').local).toBe(false)
			expect(describeTarget('postgresql://u@localhost/db?host=prod.example.com').local).toBe(false)
			expect(describeTarget('postgresql://u:p@/db?host=/var/run/postgresql').local).toBe(true)
			expect(describeTarget('sqlserver://localhost:1433;database=x;password=pw')).toEqual({
				label: 'localhost:1433',
				local: true,
			})
			expect(describeTarget('mongodb://u:p@localhost:27017,localhost:27018/db').local).toBe(true)
			expect(describeTarget('mongodb://u:p@localhost:27017,db.example.com/db').local).toBe(false)
			expect(describeTarget('jdbc:postgresql://prod.example.com/db').local).toBe(false)
			expect(describeTarget('prod.example.com:5432/db').local).toBe(false)
			expect(describeTarget('file:./dev.db').local).toBe(true)
		})

		it('should record the failed step and the cached steps before it', async () => {
			const { cache } = memoryCache()
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				cache,
			})
			let fail = false
			const seeder = defineSeeder({
				name: 'orderSeeder',
				run: async ({ step }) => {
					await step('Create customer', () => 'c1', { useCache: true })
					await step('Create order', () => {
						if (fail) throw new Error('order failed', { cause: new Error('root cause') })
						return 'o1'
					})
					return {}
				},
			})

			await runSeeders([seeder], { verbose: false, printResults: false })
			fail = true
			const log = spyOn(console, 'log')
			log.mockClear()
			const { results } = await runSeeders([seeder], { verbose: false })

			expect(results[0]?.failedStep).toBe('Create order')
			expect(results[0]?.cachedSteps).toEqual(['Create customer'])
			const printed = log.mock.calls.flat().map(String).join('\n')
			expect(printed).toContain('failed in step "Create order"')
			expect(printed).toContain('root cause')
			expect(printed).toContain('--only orderSeeder --fresh')
		})

		it('should run only the selected seeders and their dependencies, fresh where asked', async () => {
			const { store, cache } = memoryCache()
			const ran: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				cache,
			})
			const user = defineSeeder({
				name: 'user',
				run: async ({ step }) => {
					ran.push('user')
					return step('Create user', () => `user-${ran.length}`, { useCache: true })
				},
			})
			const post = defineSeeder({
				name: 'post',
				dependsOn: [user],
				run: async ({ step }, deps) => {
					ran.push('post')
					return step('Create post', () => `post-of-${deps.user}`, { useCache: true })
				},
			})
			const other = defineSeeder({ name: 'other', run: async () => ran.push('other') })
			const all = [other, post, user]

			await runSeeders(all, { verbose: false, printResults: false, only: ['post'] })
			expect(ran).toEqual(['user', 'post'])

			await runSeeders(all, {
				verbose: false,
				printResults: false,
				only: ['post'],
				fresh: ['post'],
			})
			// user replayed its cache; post ran fresh and overwrote its entry
			expect(store.get('user:create-user')).toEqual({ __plantr: 1, value: 'user-1' })
			expect(store.get('post:create-post')).toEqual({ __plantr: 1, value: 'post-of-user-1' })

			await expect(runSeeders(all, { verbose: false, only: ['ghost'] })).rejects.toThrow(
				UnknownSeederError,
			)
		})

		it('should seed faker per seeder when fakerSeed is set', async () => {
			const names: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
				fakerSeed: 1,
			})
			const seeder = defineSeeder({
				name: 'fakeSeeder',
				run: async ({ faker }) => names.push(faker.person.fullName()),
			})

			await runSeeders([seeder], { verbose: false, printResults: false })
			await runSeeders([seeder], { verbose: false, printResults: false })
			expect(names[0]).toBe(names[1])
		})
	})

	describe('runCli', () => {
		const setup = () => {
			const ran: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({ context: (base) => base })
			const user = defineSeeder({ name: 'user', run: async () => ran.push('user') })
			const post = defineSeeder({
				name: 'post',
				dependsOn: [user],
				run: async () => ran.push('post'),
			})
			const other = defineSeeder({ name: 'other', run: async () => ran.push('other') })
			const cli = (...argv: string[]) =>
				runCli([user, post, other], runSeeders, { name: 'Test', argv })
			return { ran, cli }
		}

		it('should run named seeders with their dependencies', async () => {
			const { ran, cli } = setup()
			expect(await cli('post')).toBe(0)
			expect(ran).toEqual(['user', 'post'])
		})

		it('should accept --only and --continue-on-failure', async () => {
			const { ran, cli } = setup()
			expect(await cli('--only', 'other,user', '--continue-on-failure')).toBe(0)
			expect(ran.sort()).toEqual(['other', 'user'])
		})

		it('should exit 1 on an unknown flag or seeder without running anything', async () => {
			const { ran, cli } = setup()
			expect(await cli('--fersh')).toBe(1)
			expect(await cli('all')).toBe(1)
			expect(ran).toEqual([])
		})

		it('should not run seeders on --dry-run or --help', async () => {
			const { ran, cli } = setup()
			expect(await cli('--dry-run', 'post')).toBe(0)
			expect(await cli('--help')).toBe(0)
			expect(ran).toEqual([])
		})
	})
})
