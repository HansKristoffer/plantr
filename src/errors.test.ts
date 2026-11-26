import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { runCli } from './cli.js'
import { createSeederInstance } from './create-seeder-instance.js'
import { CircularDependencyError, UnknownSeederError } from './dependency-resolver.js'
import { isSeedUsageError, SeedUsageError, usageErrorSymbol } from './errors.js'
import { SeedTargetError } from './run-seeders.js'

describe('usage errors', () => {
	beforeEach(() => {
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	it('marks SeedUsageError, plantr’s own validation errors, and errors carrying the symbol', () => {
		const usage = new SeedUsageError('Set DATABASE_URL', { cause: 'env' })
		expect(usage.name).toBe('SeedUsageError')
		expect(usage.cause).toBe('env')
		expect(isSeedUsageError(usage)).toBe(true)

		expect(new SeedTargetError('db.example.com')).toBeInstanceOf(SeedUsageError)
		expect(new SeedTargetError('db.example.com').name).toBe('SeedTargetError')
		expect(isSeedUsageError(new UnknownSeederError('x', []))).toBe(true)
		expect(isSeedUsageError(new CircularDependencyError(['a', 'b']))).toBe(true)

		class GuardError extends Error {
			readonly [usageErrorSymbol] = true
		}
		expect(isSeedUsageError(new GuardError('refused'))).toBe(true)
		// The registered symbol works for errors marked without importing plantr
		expect(
			isSeedUsageError(
				Object.assign(new Error('refused'), { [Symbol.for('plantr.usageError')]: true }),
			),
		).toBe(true)

		expect(isSeedUsageError(new Error('bug'))).toBe(false)
		expect(isSeedUsageError('Set DATABASE_URL')).toBe(false)
		expect(isSeedUsageError(null)).toBe(false)
	})

	const cliFor = (refuse: () => never) => {
		const { defineSeeder, runSeeders } = createSeederInstance({ setup: refuse })
		const seeder = defineSeeder({ name: 'a', run: () => 1 })
		return () =>
			runCli([seeder], (s, opts) => runSeeders(s as [typeof seeder], opts as never), {
				name: 'Test',
				argv: ['--quiet'],
			})
	}
	const printedErrors = (error: ReturnType<typeof spyOn>) =>
		error.mock.calls.flat().map(String).join('\n')

	it('prints only the message of a usage error thrown from a hook, and exits 1', async () => {
		const error = spyOn(console, 'error')
		error.mockClear()
		const cli = cliFor(() => {
			throw new SeedUsageError('Refusing to seed: the Firestore emulator is not on this machine')
		})

		expect(await cli()).toBe(1)
		const printed = printedErrors(error)
		expect(printed).toContain('Refusing to seed: the Firestore emulator is not on this machine')
		expect(printed).not.toContain('SeedUsageError')
		expect(printed).not.toMatch(/\n\s+at /)
	})

	it('still prints the stack of any other error', async () => {
		const error = spyOn(console, 'error')
		error.mockClear()
		const cli = cliFor(() => {
			throw new Error('connection reset')
		})

		expect(await cli()).toBe(1)
		expect(printedErrors(error)).toMatch(/connection reset[\s\S]*at /)
	})

	it('reports a seeder that fails with a usage error by its message only', async () => {
		const log = spyOn(console, 'log')
		log.mockClear()
		const { defineSeeder, runSeeders } = createSeederInstance()
		const seeder = defineSeeder({
			name: 'needsEnv',
			run: () => {
				throw new SeedUsageError('Set SEED_ADMIN_URL')
			},
		})

		const run = await runSeeders([seeder], { verbose: false })
		expect(run.success).toBe(false)
		const printed = log.mock.calls.flat().map(String).join('\n')
		expect(printed).toContain('Set SEED_ADMIN_URL')
		expect(printed).not.toMatch(/\n\s+at /)
	})
})
