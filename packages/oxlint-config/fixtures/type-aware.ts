// Fixture for the type-aware layer (requires --type-aware + oxlint-tsgolint).
// EXPECTED: exactly one diagnostic — typescript/no-floating-promises.
async function work(): Promise<number> {
	return 2;
}

export function fireAndForget(): void {
	work();
}

export function sanctioned(): void {
	void work();
}
