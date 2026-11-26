import { colorize } from './formatting.js'

type TerminationSignal = 'SIGINT' | 'SIGTERM'
type Cleanup = () => Promise<void>

/** Exit codes a shell reports for a process ended by the signal (128 + signal number) */
const EXIT_CODES: Record<TerminationSignal, number> = { SIGINT: 130, SIGTERM: 143 }

// One listener per signal for the whole process, shared by overlapping runs, so the
// first run to finish its cleanup cannot exit while another is still tearing down.
const cleanups = new Set<Cleanup>()
let received: TerminationSignal | undefined

const onSignal = (signal: TerminationSignal) => {
	if (received) {
		// A second signal while cleaning up: give up on cleanup and exit now
		process.exit(EXIT_CODES[signal])
	}
	received = signal
	console.error(
		colorize(
			`\nReceived ${signal}: tearing down before exiting (send it again to exit now)`,
			'yellow',
		),
	)
	void Promise.allSettled([...cleanups].map((cleanup) => cleanup())).then(() =>
		process.exit(EXIT_CODES[signal]),
	)
}

const listeners: Record<TerminationSignal, () => void> = {
	SIGINT: () => onSignal('SIGINT'),
	SIGTERM: () => onSignal('SIGTERM'),
}

/**
 * Run `cleanup` when the process receives SIGINT or SIGTERM, then exit with 130 or 143.
 * Returns a function that unregisters it. The listeners are installed while at least one
 * cleanup is registered, so outside a run the process keeps its default signal behavior.
 */
export function onTerminationSignal(cleanup: Cleanup): () => void {
	if (cleanups.size === 0 && !received) {
		process.on('SIGINT', listeners.SIGINT)
		process.on('SIGTERM', listeners.SIGTERM)
	}
	cleanups.add(cleanup)
	return () => {
		cleanups.delete(cleanup)
		if (cleanups.size === 0 && !received) {
			process.off('SIGINT', listeners.SIGINT)
			process.off('SIGTERM', listeners.SIGTERM)
		}
	}
}

/** Whether a termination signal arrived while a run was registered */
export const terminationSignalReceived = (): boolean => received !== undefined
