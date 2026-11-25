/**
 * Global seeding state to disable side effects during seeding.
 *
 * When seeding is active, consumers can check this state to skip
 * side effects like:
 * - Sending notifications (email, Slack, push)
 * - Creating background jobs
 * - Syncing to external services
 *
 * The flag lives on `globalThis`, so `plantr` and `plantr/state` share it even when
 * they are loaded as separate bundles. Overlapping runs are reference-counted so
 * one finishing run does not clear the flag while another is still active.
 */

const key = Symbol.for('plantr.seedingActive')
const countKey = Symbol.for('plantr.seedingCount')
const state = globalThis as { [key]?: boolean; [countKey]?: number }

/**
 * Check if seeding is currently active
 */
export function isSeedingActive(): boolean {
	return state[key] === true
}

/**
 * Set the seeding state directly.
 * Resets the active run count to 1 (true) or 0 (false).
 */
export function setSeedingActive(active: boolean): void {
	state[countKey] = active ? 1 : 0
	state[key] = active
}

/**
 * Increment the active seeding run counter and mark seeding active.
 * Called automatically by `runSeeders` when execution begins.
 */
export function enterSeeding(): void {
	const next = (state[countKey] ?? 0) + 1
	state[countKey] = next
	state[key] = true
}

/**
 * Decrement the active seeding run counter and clear the flag when no runs remain.
 * Called automatically by `runSeeders` when execution finishes.
 */
export function exitSeeding(): void {
	const next = Math.max(0, (state[countKey] ?? 0) - 1)
	state[countKey] = next
	state[key] = next > 0
}
