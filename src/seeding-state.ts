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
 * they are loaded as separate bundles. It is one flag per process, shared by every
 * seeder instance.
 */

const key = Symbol.for('plantr.seedingActive')
const state = globalThis as { [key]?: boolean }

/**
 * Check if seeding is currently active
 */
export function isSeedingActive(): boolean {
	return state[key] === true
}

/**
 * Set the seeding state.
 * Called automatically by `runSeeders` around a run.
 */
export function setSeedingActive(active: boolean): void {
	state[key] = active
}
