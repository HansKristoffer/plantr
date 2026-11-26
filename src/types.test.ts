import { describe, expect, it } from 'bun:test'
import {
	type BaseSeederContext,
	createSeederInstance,
	type ErrorConstructor,
	type ExpectFn,
	type ExpectMatchers,
	type Seeder,
	type SeederCache,
	type SeederDeps,
	type SeederName,
	type SeederOutput,
} from '../index.js'

/** Compile-time equality assertion */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false
const assertType = <_T extends true>() => {}

describe('TypeScript ergonomics and type safety', () => {
	it('infers context automatically without generics or ...base', () => {
		// Zero args
		const minimal = createSeederInstance()
		const s0 = minimal.defineSeeder({
			name: 'minimal',
			run: ({ faker, step, expect: exp }) => {
				expect(typeof faker.person.fullName).toBe('function')
				expect(typeof step).toBe('function')
				expect(typeof exp).toBe('function')
				return { ok: true }
			},
		})
		assertType<Equal<SeederName<typeof s0>, 'minimal'>>()
		assertType<Equal<SeederOutput<typeof s0>, { ok: boolean }>>()
		assertType<Equal<SeederDeps<typeof s0>, never>>()

		// Auto-merged custom context (no ...base, no <MyContext>)
		const db = { query: (sql: string) => sql.length }
		const instance = createSeederInstance({
			context: () => ({ db }),
			onAfterAll: (ctx) => {
				if (ctx) {
					const len: number = ctx.db.query('SELECT 1')
					void len
				}
			},
		})

		const s1 = instance.defineSeeder({
			name: 's1',
			run: ({ db: client, faker }) => ({
				count: client.query(faker.lorem.word()),
			}),
		})
		assertType<Equal<SeederOutput<typeof s1>, { count: number }>>()

		// Interface-based explicit generic still works
		interface LegacyContext extends BaseSeederContext {
			flag: boolean
		}
		const legacy = createSeederInstance<LegacyContext>({
			context: (base) => ({ ...base, flag: true }),
		})
		const sLegacy = legacy.defineSeeder({
			name: 'legacy',
			run: ({ flag }) => flag,
		})
		assertType<Equal<SeederOutput<typeof sLegacy>, boolean>>()

		expect(true).toBe(true)
	})

	it('enforces context compatibility across instances (contravariance)', () => {
		const baseInst = createSeederInstance()
		const dbA = createSeederInstance({ context: () => ({ a: 1 as const }) })
		const dbB = createSeederInstance({ context: () => ({ b: 'two' as const }) })

		const sharedSeeder = baseInst.defineSeeder({
			name: 'shared',
			run: () => ({ sharedId: 's1' }),
		})
		const seederA = dbA.defineSeeder({
			name: 'seederA',
			dependsOn: [sharedSeeder],
			run: ({ a }, deps) => ({ a, sharedId: deps.shared.sharedId }),
		})
		const seederB = dbB.defineSeeder({
			name: 'seederB',
			run: ({ b }) => ({ b }),
		})

		// Shared BaseSeederContext seeder is allowed in dbA
		assertType<Equal<SeederDeps<typeof seederA>, 'shared'>>()
		void (() => dbA.runSeeders([sharedSeeder, seederA]))

		// Incompatible seeder from dbB is rejected in dbA.defineSeeder.dependsOn
		void (() =>
			dbA.defineSeeder({
				name: 'badDep',
				// @ts-expect-error seederB requires { b } which dbA does not provide
				dependsOn: [seederB],
				run: () => ({}),
			}))

		// Incompatible seeder from dbB is rejected in dbA.runSeeders
		void (() =>
			dbA.runSeeders([
				// @ts-expect-error seederB requires { b } which dbA does not provide
				seederB,
			]))

		expect(true).toBe(true)
	})

	it('catches missing dependencies, only/fresh typos, and types outputs & results', () => {
		const { defineSeeder, runSeeders } = createSeederInstance()

		const user = defineSeeder({
			name: 'user',
			run: async () => ({ userId: 'u1' }),
		})
		const post = defineSeeder({
			name: 'post',
			dependsOn: [user],
			run: (_ctx, deps) => ({ postId: `p-${deps.user.userId}` }),
		})
		const extra = defineSeeder({
			name: 'extra',
			run: () => 42,
		})

		assertType<Equal<SeederDeps<typeof post>, 'user'>>()

		// Missing dependency caught at compile time
		void (() =>
			runSeeders(
				// @ts-expect-error missing required seeder "user"
				[post],
			))

		// Typo in `only` caught at compile time
		void (() =>
			runSeeders([user, post], {
				// @ts-expect-error "pst" is not a registered seeder name
				only: ['pst'],
			}))

		// Typo in `fresh` caught at compile time
		void (() =>
			runSeeders([user, post], {
				// @ts-expect-error "usr" is not a registered seeder name
				fresh: ['usr'],
			}))

		// Typed outputs without `only`
		void (async () => {
			const res = await runSeeders([user, post, extra], { verbose: false, printResults: false })
			if (res.success) {
				assertType<Equal<typeof res.outputs.user, { userId: string }>>()
				assertType<Equal<typeof res.outputs.post, { postId: string }>>()
				assertType<Equal<typeof res.outputs.extra, number>>()
			} else {
				assertType<Equal<typeof res.outputs.user, { userId: string } | undefined>>()
			}

			// Narrowing results by name and status
			const postResult = res.results.find((r) => r.name === 'post')
			if (postResult?.status === 'completed') {
				assertType<Equal<typeof postResult.output, { postId: string }>>()
				assertType<Equal<typeof postResult.durationMs, number>>()
			}
			const failedResult = res.results.find((r) => r.status === 'failed')
			if (failedResult) {
				assertType<Equal<typeof failedResult.error, Error>>()
				assertType<Equal<typeof failedResult.durationMs, number>>()
			}
			const skippedResult = res.results.find((r) => r.status === 'skipped')
			if (skippedResult) {
				assertType<Equal<typeof skippedResult.failedDeps, string[]>>()
			}
		})

		// Typed outputs with `only`: selected seeders are non-optional, unselected are optional
		void (async () => {
			const res = await runSeeders([user, post, extra], { only: ['post'] })
			if (res.success) {
				assertType<Equal<typeof res.outputs.post, { postId: string }>>()
				assertType<Equal<typeof res.outputs.extra, number | undefined>>()
			}
		})

		// Dynamic arrays gracefully widen to string without breaking
		void (async () => {
			const dynamic: Seeder<BaseSeederContext>[] = [user, post]
			await runSeeders(dynamic, { only: ['any-name'], fresh: ['any-name'] })
		})

		expect(true).toBe(true)
	})

	it('types StepOptions and SeederCache cleanly without unsafe casts', () => {
		const map = new Map<string, unknown>()
		// Sync SeederCache with zero casts
		const cache: SeederCache = {
			get: (key) => map.get(key),
			set: (key, value) => {
				map.set(key, value)
			},
			getAll: () => map,
		}

		const { defineSeeder } = createSeederInstance({ cache })

		void defineSeeder({
			name: 'stepTypes',
			run: async ({ step }) => {
				await step('plain', () => 1)
				await step('cached', () => 2, { useCache: true, key: 'k', version: { a: 1, b: ['x'] } })

				// @ts-expect-error version requires useCache: true
				await step('bad1', () => 1, { version: 1 })
				// @ts-expect-error key requires useCache: true
				await step('bad2', () => 1, { key: 'k' })
				// @ts-expect-error version must be JSON-serializable
				await step('bad3', () => 1, { useCache: true, version: () => {} })
				// @ts-expect-error BigInt is not JSON-serializable
				await step('bad4', () => 1, { useCache: true, version: 1n })
			},
		})

		expect(true).toBe(true)
	})

	it('types portable ExpectFn and custom expect (bun:test & Vitest-shaped) cleanly', () => {
		// bun:test expect is assignable to portable ExpectFn
		const bunAsPortable: ExpectFn = expect
		void bunAsPortable

		// Passing bun:test expect preserves full bun:test type on ctx.expect
		const bunInstance = createSeederInstance({
			expect,
			context: () => ({ db: true as const }),
		})
		const bunSeeder = bunInstance.defineSeeder({
			name: 'bunSeeder',
			run: ({ expect: exp, db }) => {
				assertType<Equal<typeof exp, typeof expect>>()
				exp(db).toBe(true)
				return db
			},
		})
		void bunSeeder

		// Vitest-shaped custom expect preserves its extra matchers and accepts shared seeders
		interface VitestAssertion<T = unknown> extends ExpectMatchers<T> {
			readonly not: VitestAssertion<unknown>
			toMatchObject(expected: Record<string, unknown>): void
			toThrow(expected?: string | RegExp | Error | ErrorConstructor): void
		}
		interface VitestExpect {
			<T = unknown>(actual: T, message?: string): VitestAssertion<T>
			any(ctor: ErrorConstructor): unknown
		}
		const fakeVitestExpect = (() => ({}) as VitestAssertion) as unknown as VitestExpect
		const vitestAsPortable: ExpectFn = fakeVitestExpect
		void vitestAsPortable

		const baseInst = createSeederInstance()
		const shared = baseInst.defineSeeder({
			name: 'shared',
			run: ({ expect: exp }) => {
				assertType<Equal<typeof exp, ExpectFn>>()
				exp(1).toBe(1)
				exp(1).not.toBe(2)
				return 'ok'
			},
		})

		const vitestInst = createSeederInstance({
			expect: fakeVitestExpect,
			context: (_base) => {
				assertType<Equal<typeof _base.expect, VitestExpect>>()
				return { client: 'firestore' as const }
			},
		})
		const vitestSeeder = vitestInst.defineSeeder({
			name: 'vitestSeeder',
			dependsOn: [shared],
			run: ({ expect: exp, client }, deps) => {
				assertType<Equal<typeof exp, VitestExpect>>()
				exp({ client, dep: deps.shared }).toMatchObject({ client: 'firestore' })
				return client
			},
		})
		void (() => vitestInst.runSeeders([shared, vitestSeeder]))

		// Explicit `expect: undefined` keeps default ExpectFn
		const explicitUndefined = createSeederInstance({ expect: undefined })
		void explicitUndefined.defineSeeder({
			name: 'undefExpect',
			run: ({ expect: exp }) => {
				assertType<Equal<typeof exp, ExpectFn>>()
				exp(true).toBeTruthy()
			},
		})

		expect(true).toBe(true)
	})
	it('infers resources from setup for the context factory and teardown', () => {
		type Db = { close: () => Promise<void>; query: (sql: string) => number }
		const db: Db = { close: async () => {}, query: (sql) => sql.length }
		const instance = createSeederInstance({
			setup: async ({ defer }) => {
				defer(() => {})
				return { db, token: 'secret' as const }
			},
			context: (_base, resources) => {
				assertType<Equal<typeof resources, { db: Db; token: 'secret' }>>()
				return { db: resources.db }
			},
			teardown: async (resources) => {
				assertType<Equal<typeof resources, { db: Db; token: 'secret' }>>()
				await resources.db.close()
			},
		})
		const seeder = instance.defineSeeder({
			name: 'withResources',
			run: ({ db: client }) => client.query('SELECT 1'),
		})
		assertType<Equal<SeederOutput<typeof seeder>, number>>()

		// Without setup, resources are undefined
		createSeederInstance({
			context: (_base, _resources) => {
				assertType<Equal<typeof _resources, undefined>>()
				return {}
			},
		})
		expect(true).toBe(true)
	})
})
