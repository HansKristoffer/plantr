/**
 * Runtime entry point: reads the seeding flag without loading faker or bun:test.
 *
 * @example
 * ```typescript
 * import { isSeedingActive } from 'plantr/state'
 *
 * if (isSeedingActive()) return // skip jobs and mail while seeding
 * ```
 */
export { isSeedingActive } from './src/seeding-state'
