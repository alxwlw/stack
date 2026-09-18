// Fixture for stack/tsdoc-syntax (base preset, ts/tsx override). EXPECTED:
// diagnostics only on `bad` — tsdoc-param-tag-with-invalid-type (JSDoc-style
// {type}) and tsdoc-undefined-tag (@notATag).

/**
 * Good doc.
 * @param x - the value
 * @returns the same value
 */
export function good(x: number): number {
	return x;
}

/**
 * Bad doc.
 * @param {number} x - carries a JSDoc-style type
 * @notATag some unknown tag
 */
export function bad(x: number): number {
	return x;
}
