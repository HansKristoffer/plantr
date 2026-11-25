import { parseArgs } from 'node:util'
import { resolveDependencyOrder } from './dependency-resolver.js'
import { colorize } from './formatting.js'
import { describeTarget } from './run-seeders.js'
import type { RunSeedersOptions, SeederAny } from './types.js'

/** Options for `runSeedersCli` */
export type RunSeedersCliOptions = {
	/** Display name shown in the banner (default: `'Seeders'`) */
	name?: string | undefined
	/** Arguments to parse (default: `process.argv.slice(2)`) */
	argv?: readonly string[] | undefined
}

type CliRunner = (
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

function formatSeedersList(seeders: readonly SeederAny[]): string {
	if (seeders.length === 0) return 'No seeders registered.'
	const maxLen = Math.max(...seeders.map((s) => s.name.length))
	const lines = seeders.map((s) => {
		const desc = s.description ? `  ${colorize(s.description, 'dim')}` : ''
		return `  ${s.name.padEnd(maxLen)}${desc}`
	})
	return `${colorize(`Registered seeders (${seeders.length}):`, 'white', 'bold')}\n${lines.join('\n')}`
}

const helpText = (seeders: readonly SeederAny[]) => `
${colorize('Usage:', 'cyan', 'bold')} bun run seed [seeder...] [options]

${colorize('Arguments:', 'white', 'bold')}
  seeder...              Run only these seeders and the seeders they depend on

${colorize('Options:', 'white', 'bold')}
  --only a,b             Same as naming the seeders
  --fresh                Ignore and overwrite cached steps of the named seeders
                         (of every seeder when none are named)
  --concurrency, -c <n>  Run up to <n> independent seeders in parallel (default: 1)
  --continue-on-failure  Keep running seeders that do not depend on a failed one
  --allow-remote         Seed a database that is not local
  --quiet, -q            Suppress progress and step output (keep results table)
  --dry-run              Show execution order without running seeders
  --list, -l             List registered seeders in dependency order and exit
  --help, -h             Show this help message

${formatSeedersList(seeders)}
`

/**
 * Parse CLI arguments, run the seeders and return the exit code.
 * Unknown flags and unknown seeder names return 1.
 */
export async function runCli(
	seeders: readonly SeederAny[],
	runSeeders: CliRunner,
	{
		argv,
		target,
		defaultConcurrency,
	}: {
		name: string
		argv: readonly string[]
		target?: (() => string | undefined) | undefined
		defaultConcurrency?: number | undefined
	},
): Promise<number> {
	let parsed: ReturnType<typeof parse>
	try {
		parsed = parse(argv)
	} catch (error) {
		console.error(colorize(error instanceof Error ? error.message : String(error), 'red'))
		console.log(helpText(seeders))
		return 1
	}
	const { values, positionals } = parsed

	if (values.help) {
		console.log(helpText(seeders))
		return 0
	}

	let concurrency: number | undefined
	if (values.concurrency !== undefined) {
		const parsedConcurrency =
			values.concurrency.toLowerCase() === 'infinity'
				? Number.POSITIVE_INFINITY
				: Number(values.concurrency)
		if (
			Number.isNaN(parsedConcurrency) ||
			parsedConcurrency < 1 ||
			(Number.isFinite(parsedConcurrency) && !Number.isInteger(parsedConcurrency))
		) {
			console.error(
				colorize(
					`Invalid --concurrency value "${values.concurrency}": expected a positive integer`,
					'red',
				),
			)
			return 1
		}
		concurrency = parsedConcurrency
	}

	const names = [...positionals, ...(values.only ?? []).flatMap((value) => value.split(','))]
		.map((value) => value.trim())
		.filter(Boolean)
	const only = names.length > 0 ? names : undefined

	try {
		if (values.list) {
			const order = resolveDependencyOrder(seeders, only)
			const seederMap = new Map(seeders.map((s) => [s.name, s]))
			console.log(
				`\n${colorize('🌱 Seeders', 'cyan', 'bold')} ${colorize(`(${order.length})`, 'dim')}\n`,
			)
			const maxLen = Math.max(0, ...order.map((n) => n.length))
			for (const seederName of order) {
				const seeder = seederMap.get(seederName)
				const desc = seeder?.description ? `  ${colorize(seeder.description, 'dim')}` : ''
				const deps = seeder?.dependsOn ?? []
				const depsStr =
					deps.length > 0 ? ` ${colorize(`[depends on: ${deps.join(', ')}]`, 'dim')}` : ''
				console.log(`  ${seederName.padEnd(maxLen)}${desc}${depsStr}`)
			}
			console.log('')
			return 0
		}

		if (values['dry-run']) {
			const order = resolveDependencyOrder(seeders, only)
			const seederMap = new Map(seeders.map((s) => [s.name, s]))
			const targetUrl = target?.()
			const targetDesc = targetUrl ? describeTarget(targetUrl) : undefined
			const targetText = targetDesc
				? ` ${colorize(`→ ${targetDesc.label}`, 'dim')}${targetDesc.local ? '' : ` ${colorize('(remote)', 'yellow')}`}`
				: ''
			const freshSet = values.fresh ? (only ? new Set(only) : true) : false
			const effectiveConcurrency = concurrency ?? defaultConcurrency ?? 1
			const concurrencyText =
				effectiveConcurrency > 1
					? `, concurrency: ${effectiveConcurrency === Number.POSITIVE_INFINITY ? '∞' : effectiveConcurrency}`
					: ''

			console.log(
				`\n${colorize('🌱 Dry Run', 'cyan', 'bold')} ${colorize(`(${order.length} ${order.length === 1 ? 'seeder' : 'seeders'}${concurrencyText})`, 'dim')}${targetText}\n`,
			)

			const printItem = (seederName: string, num: number, indent: string) => {
				const seeder = seederMap.get(seederName)
				const deps = seeder?.dependsOn ?? []
				const depsStr =
					deps.length > 0 ? ` ${colorize(`(depends on: ${deps.join(', ')})`, 'dim')}` : ''
				const freshStr =
					freshSet === true || (freshSet instanceof Set && freshSet.has(seederName))
						? ` ${colorize('(fresh)', 'yellow')}`
						: ''
				console.log(`${indent}${num}. ${seederName}${depsStr}${freshStr}`)
				if (seeder?.description) {
					console.log(`${indent}   ${colorize(seeder.description, 'dim')}`)
				}
			}

			if (effectiveConcurrency > 1 && order.length > 0) {
				const waveOf = new Map<string, number>()
				const waves: string[][] = []
				for (const seederName of order) {
					const deps = seederMap.get(seederName)?.dependsOn ?? []
					let wave = 0
					for (const dep of deps) {
						wave = Math.max(wave, (waveOf.get(dep) ?? 0) + 1)
					}
					waveOf.set(seederName, wave)
					let bucket = waves[wave]
					if (!bucket) {
						bucket = []
						waves[wave] = bucket
					}
					bucket.push(seederName)
				}

				console.log(
					colorize(
						`Execution plan (${waves.length} ${waves.length === 1 ? 'wave' : 'waves'}):`,
						'white',
						'bold',
					),
				)
				let index = 1
				waves.forEach((waveSeeders, waveIdx) => {
					const parallelTag = waveSeeders.length > 1 ? ` ${colorize('(parallel)', 'cyan')}` : ''
					console.log(`  ${colorize(`Wave ${waveIdx + 1}`, 'white', 'bold')}${parallelTag}`)
					for (const seederName of waveSeeders) {
						printItem(seederName, index++, '    ')
					}
				})
			} else {
				console.log(colorize('Execution order:', 'white', 'bold'))
				order.forEach((seederName, i) => {
					printItem(seederName, i + 1, '  ')
				})
			}
			console.log('')
			return 0
		}

		const { success } = await runSeeders(seeders, {
			printResults: true,
			verbose: !values.quiet,
			only,
			fresh: values.fresh ? (only ?? true) : false,
			continueOnFailure: values['continue-on-failure'],
			allowRemote: values['allow-remote'],
			concurrency,
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
			list: { type: 'boolean', short: 'l' },
			quiet: { type: 'boolean', short: 'q' },
			concurrency: { type: 'string', short: 'c' },
			'dry-run': { type: 'boolean' },
			only: { type: 'string', multiple: true },
			fresh: { type: 'boolean' },
			'continue-on-failure': { type: 'boolean' },
			'allow-remote': { type: 'boolean' },
		},
	})
}
