import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import type { Repo } from './repo.ts';

// package.json#packageManager — второй источник версии pnpm рядом с .prototools: pnpm сам
// переключается на версию из поля, и пин канона молча перестаёт действовать. Держим поле на пине
// канона. Адрес — .prototools: одно исключение удерживает оба симптома одного решения.
export function planPackageManager(repo: Repo, canon: Canon): Drift[] {
	const current = repo.packages.get('package.json')?.packageManager;
	if (typeof current !== 'string' || !current.startsWith('pnpm@')) return [];
	// `pnpm@11.15.0+sha512.…` — хэш относится к той же версии, сравниваем только её.
	if (current.slice('pnpm@'.length).split('+')[0] === canon.pins.pnpm) return [];
	const want = `pnpm@${canon.pins.pnpm}`;
	return [
		{
			code: 'package-manager',
			target: 'package.json:packageManager',
			message: `"${current}" instead of "${want}" — pnpm would switch to it and bypass .prototools`,
			fix: `package.json packageManager: ${current} → ${want}`,
			change: { kind: 'json-set', file: 'package.json', path: ['packageManager'], value: want },
		},
	];
}
