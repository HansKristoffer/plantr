/**
 * Global seeding state to disable side effects during seeding.
 *
 * When seeding is active, consumers can check this state to skip
 * side effects like:
 * - Sending notifications (email, Slack, push)
 * - Creating background jobs
 * - Syncing to external services
 */

let isSeeding = false

/**
 * Check if seeding is currently active
 */
export function isSeedingActive(): boolean {
	return isSeeding
}

/**
 * Set the seeding state.
 * Called automatically by the seeder runner's onBeforeAll/onAfterAll hooks.
 */
export function setSeedingActive(active: boolean): void {
	isSeeding = active
}
