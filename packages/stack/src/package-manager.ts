import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';

import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';

// package.json#packageManager — второй источник версии pnpm рядом с .prototools: pnpm сам
// переключается на версию из поля, и пин канона молча перестаёт действовать. Держим поле на пине
// канона. Адрес — .prototools: одно исключение удерживает оба симптома одного решения.
export function planPackageManager(repoRoot: string, canon: Canon): Drift[] {
	const path = join(repoRoot, 'package.json');
	if (!existsSync(path)) return [];
	const text = readFileSync(path, 'utf8');
	let current: unknown;
	try {
		current = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
	} catch {
		// Нечитаемый package.json — находка unreadable-file у checkEnginesNode, не здесь.
		return [];
	}
	if (typeof current !== 'string' || !current.startsWith('pnpm@')) return [];
	// `pnpm@11.15.0+sha512.…` — хэш относится к той же версии, сравниваем только её.
	if (current.slice('pnpm@'.length).split('+')[0] === canon.pnpmPin) return [];
	const want = `pnpm@${canon.pnpmPin}`;
	return [
		{
			code: 'package-manager',
			target: 'package.json:packageManager',
			message: `"${current}" instead of "${want}" — pnpm would switch to it and bypass .prototools`,
			address: { file: '.prototools' },
			fix: `package.json packageManager: ${current} → ${want}`,
			apply() {
				// modify+applyEdits меняет только значение поля: отступы и порядок ключей остаются.
				const now = readFileSync(path, 'utf8');
				writeFileSync(path, applyEdits(now, modify(now, ['packageManager'], want, {})));
			},
		},
	];
}
