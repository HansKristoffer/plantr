import type { SeederResult } from './types'

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

type ColorName = 'red' | 'green' | 'yellow' | 'cyan' | 'white' | 'gray' | 'dim'
type StyleName = 'bold' | 'dim'

/**
 * Simple colorize function for terminal output
 */
export function colorize(text: string, color: ColorName, style?: StyleName): string {
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
	if (ms < 1000) return `${ms}ms`
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
	return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Print a formatted table of seeder results
 */
export function printResultsTable(results: SeederResult[]): void {
	if (results.length === 0) {
		console.log('No seeders registered')
		return
	}

	// Calculate column widths
	const nameHeader = 'Seeder'
	const statusHeader = 'Status'
	const durationHeader = 'Duration'

	const maxNameLen = Math.max(nameHeader.length, ...results.map((r) => r.name.length))
	const maxStatusLen = Math.max(
		statusHeader.length,
		10, // "✗ Failed" is the longest status
	)
	const maxDurationLen = Math.max(
		durationHeader.length,
		...results.map((r) => formatDuration(r.durationMs ?? 0).length),
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

		switch (result.status) {
			case 'completed':
				statusDisplay = '✓ Done'
				statusColor = 'green'
				break
			case 'failed':
				statusDisplay = '✗ Failed'
				statusColor = 'red'
				break
			case 'skipped':
				statusDisplay = '⊘ Skipped'
				statusColor = 'yellow'
				break
			case 'running':
				statusDisplay = '⟳ Running'
				statusColor = 'yellow'
				break
			default:
				statusDisplay = '○ Pending'
				statusColor = 'gray'
		}

		const duration = result.durationMs !== undefined ? formatDuration(result.durationMs) : '-'

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
 * stack, cause and own fields via Bun.inspect) and a hint when cached steps ran first.
 * Under GitHub Actions, also prints one `::error` annotation per failed seeder.
 */
export function printErrors(results: SeederResult[]): void {
	const failed = results.filter((r) => r.status === 'failed')

	for (const result of failed) {
		const where = result.failedStep ? ` in step "${result.failedStep}"` : ''
		console.log(colorize(`❌ Seeder "${result.name}" failed${where}:`, 'red'))
		if (result.error) {
			const details = Bun.inspect(result.error, { colors: Boolean(process.stdout.isTTY) })
			for (const line of details.split('\n')) console.log(`   ${line}`)
		}
		const cached = result.cachedSteps ?? []
		if (cached.length > 0) {
			console.log(
				colorize(
					`   ${cached.length} earlier step(s) came from the cache: ${cached.join(', ')}. If they are stale, run this seeder fresh (CLI: --only ${result.name} --fresh).`,
					'yellow',
				),
			)
		}
		if (process.env.GITHUB_ACTIONS === 'true') {
			const title = `Seeder ${result.name} failed${where}`.replace(/[:,]/g, ' ')
			console.log(
				`::error title=${escapeAnnotation(title)}::${escapeAnnotation(result.error?.message ?? 'failed')}`,
			)
		}
		console.log('')
	}
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
 * Print completion status after a seeder runs
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
 * Print the initial banner when seeding starts
 */
export function printStartBanner(target?: { label: string; local: boolean }): void {
	const targetText = target
		? ` ${colorize(`→ ${target.label}`, 'dim')}${target.local ? '' : ` ${colorize('(remote, allowed)', 'yellow')}`}`
		: ''
	console.log(`\n${colorize('🌱 Running Seeders', 'cyan', 'bold')}${targetText}\n`)
}

/**
 * Print message when a seeder is skipped due to failed dependencies
 */
export function printSeederSkipped(failedDeps: string[]): void {
	console.log('')
	console.log(colorize(`    ⊘ Skipped (depends on failed: ${failedDeps.join(', ')})`, 'yellow'))
	console.log('')
}

/**
 * Print the final summary after all seeders complete
 */
export function printSummary(results: SeederResult[]): void {
	const completed = results.filter((r) => r.status === 'completed').length
	const failed = results.filter((r) => r.status === 'failed').length
	const skipped = results.filter((r) => r.status === 'skipped').length
	const pending = results.filter((r) => r.status === 'pending').length

	if (failed > 0 || skipped > 0) {
		const parts = [`${completed} completed`]
		if (failed > 0) parts.push(`${failed} failed`)
		if (skipped > 0) parts.push(`${skipped} skipped`)
		if (pending > 0) parts.push(`${pending} pending`)
		console.log(colorize(`Seeding failed: ${parts.join(', ')}`, 'red'))
	} else {
		console.log(
			`${colorize('✓ Seeding complete:', 'green')} ${completed} seeders executed successfully\n`,
		)
	}
}
