// EXPECTED with node/nest preset: NO naming diagnostics — *.config.ts (like *.test.ts /
// *.spec.ts) sits in the disableTypeChecked mirror. Named .config.ts so bun test does not
// collect the fixture as a suite.
export const PascalLocalInTest = 1;
export function checkNaming(): void {
	const JSZip = PascalLocalInTest;
	void JSZip;
}
