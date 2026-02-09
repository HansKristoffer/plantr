import type { Seeder, SeederAny, SeederConfig } from './types'

/**
 * Create a typed seeder definition
 *
 * This is the core factory that creates a seeder from a configuration.
 * The seeder can then be passed to `runSeeders` for execution.
 *
 * @example
 * ```typescript
 * import { defineSeeder } from './registries/seed'
 *
 * export default defineSeeder({
 *   name: 'createUsers',
 *   description: 'Seeds user data',
 *   dependsOn: [organizationSeeder],
 *   run: async (ctx, deps) => {
 *     // ctx contains whatever the consumer configured
 *     // deps.organizationSeeder is fully typed with the output of organizationSeeder
 *     const { organizationId } = deps.organizationSeeder
 *
 *     // ... create users
 *
 *     return { userIds: [...] }
 *   }
 * })
 * ```
 */
export function createDefineSeeder<TContext>() {
	return function defineSeeder<
		TName extends string,
		TOutput,
		const TDeps extends readonly SeederAny[] = readonly [],
	>(config: SeederConfig<TContext, TName, TOutput, TDeps>): Seeder<TContext, TName, TOutput> {
		// Extract names from seeder objects at runtime
		const dependsOnNames = (config.dependsOn ?? []).map((seeder) => seeder.name)

		return {
			name: config.name,
			description: config.description,
			dependsOn: dependsOnNames,
			// Cast is safe because the deps object will have the correct shape at runtime
			run: config.run as (ctx: TContext, deps: Record<string, unknown>) => Promise<TOutput>,
		}
	}
}
