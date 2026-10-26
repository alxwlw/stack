import type { Canon } from './canon.ts';

// Канон для тестов правил. Пины нарочно не равны реальным пинам канона: иначе константа,
// зашитая в правило, осталась бы незамеченной (engines-node в deps.ts, packageManager в package-manager.ts).
export function testCanon(over: Partial<Canon> = {}): Canon {
	return { files: [], catalogs: {}, pins: { node: '25.4.1', pnpm: '10.99.0' }, ...over };
}
