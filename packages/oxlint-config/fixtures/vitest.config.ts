// EXPECTED with node/nest preset: NO naming diagnostics — tool config files
// (vite/vitest/…) sit in the disableTypeChecked mirror. Named `.config.ts` so bun test does not
// collect the fixture as a suite.
export const PascalLocalInTest = 1;
export function checkNaming(): void {
	const JSZip = PascalLocalInTest;
	void JSZip;
}
