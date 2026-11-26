import { inspect as nodeInspect } from 'node:util'
import { isSeedUsageError } from './errors.js'
import type { SeederResult } from './types.js'

type BunInspectGlobal = {
	Bun?: {
		inspect?: (value: unknown, options?: { colors?: boolean }) => string
	}
}

/**
 * Runtime-safe value inspection: uses `Bun.inspect` on Bun and falls back to
 * `node:util`'s `inspect` on Node.js.
 */
export function inspectValue(value: unknown, options?: { colors?: boolean }): string {
	const bunInspect = (globalThis as BunInspectGlobal).Bun?.inspect
	if (typeof bunInspect === 'function') {
		return options ? bunInspect(value, options) : bunInspect(value)
	}
	return nodeInspect(value, { colors: options?.colors ?? false })
}

/**
 * An error as the person running the seed should see it: a usage error by its message
 * alone, anything else in full (message, stack, `cause` and extra fields).
 */
export function formatError(error: unknown, options?: { colors?: boolean }): string {
	return isSeedUsageError(error) ? error.message : inspectValue(error, options)
}

/**
 * ANSI color codes for terminal output
 */
const colors = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',
	gray: '\x1b[90m',
} as const

export type ColorName = 'red' | 'green' | 'yellow' | 'cyan' | 'white' | 'gray' | 'dim'
export type StyleName = 'bold' | 'dim'

function supportsColor(): boolean {
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
	if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true
	return Boolean(process.stdout.isTTY)
}

/**
 * Simple colorize function for terminal output.
 * Respects `NO_COLOR`, `FORCE_COLOR`, and stdout TTY state.
 */
export function colorize(text: string, color: ColorName, style?: StyleName): string {
	if (!supportsColor()) return text
	let result = ''
	if (style === 'bold') result += colors.bold
	if (style === 'dim') result += colors.dim
	result += colors[color] + text + colors.reset
	return result
}

/**
 * Format duration in a human-readable way
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
	return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Print a formatted table of seeder results
 */
export function printResultsTable(results: readonly SeederResult[]): void {
	if (results.length === 0) {
		console.log('No seeders registered')
		return
	}

	const nameHeader = 'Seeder'
	const statusHeader = 'Status'
	const durationHeader = 'Duration'

	const maxNameLen = Math.max(nameHeader.length, ...results.map((r) => r.name.length))
	const maxStatusLen = Math.max(
		statusHeader.length,
		10, // "⊘ Skipped" / "○ Pending" fit with padding
	)
	const maxDurationLen = Math.max(
		durationHeader.length,
		...results.map((r) => {
			if (r.status === 'completed' || r.status === 'failed') {
				return formatDuration(r.durationMs).length
			}
			return 1 // "-"
		}),
	)

	const topBorder = `┌${'─'.repeat(maxNameLen + 2)}┬${'─'.repeat(maxStatusLen + 2)}┬${'─'.repeat(maxDurationLen + 2)}┐`
	const divider = `├${'─'.repeat(maxNameLen + 2)}┼${'─'.repeat(maxStatusLen + 2)}┼${'─'.repeat(maxDurationLen + 2)}┤`
	const bottomBorder = `└${'─'.repeat(maxNameLen + 2)}┴${'─'.repeat(maxStatusLen + 2)}┴${'─'.repeat(maxDurationLen + 2)}┘`

	console.log('')
	console.log(topBorder)
	console.log(
		`│ ${colorize(nameHeader.padEnd(maxNameLen), 'white', 'bold')} │ ${colorize(statusHeader.padEnd(maxStatusLen), 'white', 'bold')} │ ${colorize(durationHeader.padEnd(maxDurationLen), 'white', 'bold')} │`,
	)
	console.log(divider)

	for (const result of results) {
		let statusDisplay: string
		let statusColor: ColorName
		let duration = '-'

		switch (result.status) {
			case 'completed':
				statusDisplay = '✓ Done'
				statusColor = 'green'
				duration = formatDuration(result.durationMs)
				break
			case 'failed':
				statusDisplay = '✗ Failed'
				statusColor = 'red'
				duration = formatDuration(result.durationMs)
				break
			case 'skipped':
				statusDisplay = '⊘ Skipped'
				statusColor = 'yellow'
				break
			case 'pending':
				statusDisplay = '○ Pending'
				statusColor = 'gray'
				break
		}

		console.log(
			`│ ${result.name.padEnd(maxNameLen)} │ ${colorize(statusDisplay.padEnd(maxStatusLen), statusColor)} │ ${colorize(duration.padEnd(maxDurationLen), 'dim')} │`,
		)
	}

	console.log(bottomBorder)
	console.log('')
}

const escapeAnnotation = (text: string) =>
	text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/**
 * Print error details for failed seeders: the failing step, the full error (message,
 * stack, cause and own fields via Bun.inspect on Bun or util.inspect on Node.js) and
 * a hint when cached steps ran first.
 * Under GitHub Actions, also prints one `::error` annotation per failed seeder.
 */
export function printErrors(results: readonly SeederResult[]): void {
	const failed = results.filter((r) => r.status === 'failed')

	for (const result of failed) {
		const where = result.failedStep ? ` in step "${result.failedStep}"` : ''
		console.log(colorize(`❌ Seeder "${result.name}" failed${where}:`, 'red'))
		const details = formatError(result.error, { colors: supportsColor() })
		for (const line of details.split('\n')) console.log(`   ${line}`)
		if (result.cachedSteps.length > 0) {
			console.log(
				colorize(
					`   ${result.cachedSteps.length} earlier step(s) came from the cache: ${result.cachedSteps.join(', ')}. If they are stale, run this seeder fresh (CLI: --only ${result.name} --fresh).`,
					'yellow',
				),
			)
		}
		if (process.env.GITHUB_ACTIONS === 'true') {
			const title = `Seeder ${result.name} failed${where}`.replace(/[:,]/g, ' ')
			console.log(
				`::error title=${escapeAnnotation(title)}::${escapeAnnotation(result.error.message || 'failed')}`,
			)
		}
		console.log('')
	}
}

/**
 * Print errors thrown while cleaning up (cache flush, onAfterAll, teardown, deferred
 * cleanups) that are not rethrown, so a second failure is never silently lost.
 */
export function printCleanupErrors(errors: readonly unknown[]): void {
	for (const error of errors) {
		console.error(colorize('Cleanup after the run also failed:', 'red'))
		for (const line of formatError(error, { colors: supportsColor() }).split('\n')) {
			console.error(`   ${line}`)
		}
	}
}

/**
 * Print that `onFresh` is about to run, before the seeders
 */
export function printFreshReset(seeders: readonly string[], all: boolean): void {
	const which = all ? 'every seeder runs fresh' : `fresh: ${seeders.join(', ')}`
	console.log(colorize(`↺ onFresh (${which})`, 'yellow'))
	console.log('')
}

/**
 * Print seeder header before execution
 */
export function printSeederHeader(
	name: string,
	index: number,
	total: number,
	description?: string,
): void {
	const seederIndex = `[${index + 1}/${total}]`
	const headerLine = `━━━ ${seederIndex} ${name} ${'━'.repeat(Math.max(0, 50 - name.length - seederIndex.length))}`
	console.log(colorize(headerLine, 'cyan', 'bold'))
	if (description) {
		console.log(colorize(`    ${description}`, 'dim'))
	}
	console.log('')
}

/**
 * Print completion status after a seeder runs (sequential mode)
 */
export function printSeederComplete(durationMs: number, success: boolean): void {
	console.log('')
	if (success) {
		console.log(colorize(`    ✓ Completed in ${formatDuration(durationMs)}`, 'green'))
	} else {
		console.log(colorize(`    ✗ Failed after ${formatDuration(durationMs)}`, 'red'))
	}
	console.log('')
}

/**
 * Print compact prefixed completion status (concurrent mode)
 */
export function printConcurrentComplete(
	seederName: string,
	durationMs: number,
	success: boolean,
): void {
	const tag = colorize(`[${seederName}]`, 'cyan', 'bold')
	if (success) {
		console.log(`  ${tag} ${colorize(`✓ Completed in ${formatDuration(durationMs)}`, 'green')}`)
	} else {
		console.log(`  ${tag} ${colorize(`✗ Failed after ${formatDuration(durationMs)}`, 'red')}`)
	}
}

/**
 * Print compact prefixed skip status (concurrent mode)
 */
export function printConcurrentSkipped(seederName: string, failedDeps: readonly string[]): void {
	const tag = colorize(`[${seederName}]`, 'cyan', 'bold')
	console.log(
		`  ${tag} ${colorize(`⊘ Skipped (depends on failed: ${failedDeps.join(', ')})`, 'yellow')}`,
	)
}

/**
 * Print the initial banner when seeding starts
 */
export function printStartBanner(options?: {
	name?: string | undefined
	count?: number | undefined
	target?: { label: string; local: boolean } | undefined
	concurrency?: number | undefined
}): void {
	const name = options?.name ?? 'Seeders'
	const countText =
		options?.count !== undefined
			? ` ${colorize(`(${options.count} ${options.count === 1 ? 'seeder' : 'seeders'}${options.concurrency && options.concurrency > 1 ? `, concurrency: ${options.concurrency === Number.POSITIVE_INFINITY ? '∞' : options.concurrency}` : ''})`, 'dim')}`
			: ''
	const target = options?.target
	const targetText = target
		? ` ${colorize(`→ ${target.label}`, 'dim')}${target.local ? '' : ` ${colorize('(remote, allowed)', 'yellow')}`}`
		: ''
	console.log(`\n${colorize(`🌱 Running ${name}`, 'cyan', 'bold')}${countText}${targetText}\n`)
}

/**
 * Print message when a seeder is skipped due to failed dependencies
 */
export function printSeederSkipped(failedDeps: readonly string[]): void {
	console.log('')
	console.log(colorize(`    ⊘ Skipped (depends on failed: ${failedDeps.join(', ')})`, 'yellow'))
	console.log('')
}

/**
 * Print the final summary after all seeders complete
 */
export function printSummary(
	results: readonly SeederResult[],
	totalDurationMs?: number,
	concurrency = 1,
): void {
	let completed = 0
	let failed = 0
	let skipped = 0
	let pending = 0
	let cachedCount = 0
	let totalWorkMs = 0

	for (const r of results) {
		switch (r.status) {
			case 'completed':
				completed++
				cachedCount += r.cachedSteps.length
				totalWorkMs += r.durationMs
				break
			case 'failed':
				failed++
				cachedCount += r.cachedSteps.length
				totalWorkMs += r.durationMs
				break
			case 'skipped':
				skipped++
				break
			case 'pending':
				pending++
				break
		}
	}

	const durationSuffix =
		totalDurationMs !== undefined ? ` in ${formatDuration(totalDurationMs)}` : ''
	const speedupSuffix =
		concurrency > 1 &&
		totalDurationMs !== undefined &&
		totalDurationMs > 0 &&
		totalWorkMs > totalDurationMs * 1.1
			? ` ${colorize(`(${formatDuration(totalWorkMs)} work, ${(totalWorkMs / totalDurationMs).toFixed(1)}× faster)`, 'dim')}`
			: ''
	const cacheSuffix =
		cachedCount > 0
			? ` ${colorize(`(${cachedCount} cached ${cachedCount === 1 ? 'step' : 'steps'})`, 'cyan')}`
			: ''

	if (failed > 0 || skipped > 0) {
		const parts = [`${completed} completed`]
		if (failed > 0) parts.push(`${failed} failed`)
		if (skipped > 0) parts.push(`${skipped} skipped`)
		if (pending > 0) parts.push(`${pending} pending`)
		console.log(colorize(`Seeding failed: ${parts.join(', ')}${durationSuffix}`, 'red'))
	} else {
		console.log(
			`${colorize('✓ Seeding complete:', 'green')} ${completed} ${completed === 1 ? 'seeder' : 'seeders'} executed successfully${durationSuffix}${speedupSuffix}${cacheSuffix}\n`,
		)
	}
}
