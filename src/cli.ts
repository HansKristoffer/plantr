import { parseArgs } from 'node:util'
import { resolveDependencyOrder } from './dependency-resolver'
import { colorize } from './formatting'
import type { RunSeedersOptions, SeederAny } from './types'

type RunSeeders = (
	seeders: readonly SeederAny[],
	options?: RunSeedersOptions,
) => Promise<{ success: boolean }>

/** Errors whose message says everything; others are printed with their stack */
const USAGE_ERRORS = new Set([
	'CircularDependencyError',
	'MissingDependencyError',
	'DuplicateSeederError',
	'UnknownSeederError',
	'SeedTargetError',
])

const helpText = (count: number) => `
${colorize('Usage:', 'cyan', 'bold')} bun run seed [seeder...] [options]

${colorize('Arguments:', 'white', 'bold')}
  seeder...              Run only these seeders and the seeders they depend on

${colorize('Options:', 'white', 'bold')}
  --only a,b             Same as naming the seeders
  --fresh                Ignore and overwrite cached steps of the named seeders
                         (of every seeder when none are named)
  --continue-on-failure  Keep running seeders that do not depend on a failed one
  --allow-remote         Seed a database that is not local
  --dry-run              Show execution order without running seeders
  --help, -h             Show this help message

${count} seeders registered.
`

/**
 * Parse CLI arguments, run the seeders and return the exit code.
 * Unknown flags and unknown seeder names return 1.
 */
export async function runCli(
	seeders: readonly SeederAny[],
	runSeeders: RunSeeders,
	{ name, argv }: { name: string; argv: readonly string[] },
): Promise<number> {
	let parsed: ReturnType<typeof parse>
	try {
		parsed = parse(argv)
	} catch (error) {
		console.error(colorize(error instanceof Error ? error.message : String(error), 'red'))
		console.log(helpText(seeders.length))
		return 1
	}
	const { values, positionals } = parsed

	if (values.help) {
		console.log(helpText(seeders.length))
		return 0
	}

	const names = [...positionals, ...(values.only ?? []).flatMap((value) => value.split(','))]
		.map((value) => value.trim())
		.filter(Boolean)
	const only = names.length > 0 ? names : undefined

	try {
		const order = resolveDependencyOrder(seeders, only)

		if (values['dry-run']) {
			console.log(
				`\n${colorize('🌱 Dry Run', 'cyan', 'bold')} ${colorize(`(${order.length} seeders)`, 'dim')}\n`,
			)
			console.log(colorize('Execution order:', 'white', 'bold'))
			order.forEach((seederName, i) => {
				const deps = seeders.find((seeder) => seeder.name === seederName)?.dependsOn ?? []
				const depsStr =
					deps.length > 0 ? ` ${colorize(`(depends on: ${deps.join(', ')})`, 'dim')}` : ''
				console.log(`  ${i + 1}. ${seederName}${depsStr}`)
			})
			console.log('')
			return 0
		}

		console.log(
			`\n${colorize(`🌱 Running ${name}`, 'cyan', 'bold')} ${colorize(`(${order.length} seeders)`, 'dim')}\n`,
		)
		const { success } = await runSeeders(seeders, {
			printResults: true,
			verbose: true,
			only,
			fresh: values.fresh ? (only ?? true) : false,
			continueOnFailure: values['continue-on-failure'],
			allowRemote: values['allow-remote'],
		})
		return success ? 0 : 1
	} catch (error) {
		const usage = error instanceof Error && USAGE_ERRORS.has(error.name)
		console.error(colorize(usage ? (error as Error).message : Bun.inspect(error), 'red'))
		return 1
	}
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			help: { type: 'boolean', short: 'h' },
			'dry-run': { type: 'boolean' },
			only: { type: 'string', multiple: true },
			fresh: { type: 'boolean' },
			'continue-on-failure': { type: 'boolean' },
			'allow-remote': { type: 'boolean' },
		},
	})
}
