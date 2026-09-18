// Fixture for stack/naming-convention (node preset, canon defaults —
// leadingUnderscore "none"). EXPECTED diagnostics: exactly three —
// badFunctionName_x (Function), badIface (Interface), NestedPascal (Variable).
export const okCamel = 1;
export const OK_UPPER = 2;
export const OkPascalTop = 3; // top-level const may be PascalCase
export const $dollarOk = 4; // caseless first char passes camelCase (ts-eslint parity)
export const φ1 = 5; // Greek: caseless per toLowerCase — legal (ts-eslint parity)

export function badFunctionName_x(): number {
	return okCamel;
}

export function okFn(_unusedArg: string, camelArg?: number): void {
	void _unusedArg;
	void camelArg;
}

export interface GoodIface {
	a: number;
}

export interface badIface {
	a: number;
}

export enum GoodEnum {
	GOOD_MEMBER,
	AlsoGood,
}

export function nested(): void {
	const NestedPascal = 1; // nested const: PascalCase NOT allowed (not top-level)
	void NestedPascal;
}
