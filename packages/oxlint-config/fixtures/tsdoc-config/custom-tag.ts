// Фикстура: @lintignore объявлен в соседнем tsdoc.json — находок нет; @notATag не объявлен — одна.

/**
 * Помечен собственным тегом потребителя.
 * @lintignore
 */
export function marked(): number {
	return 1;
}

/**
 * Неизвестный тег.
 * @notATag
 */
export function unknown(): number {
	return 2;
}
