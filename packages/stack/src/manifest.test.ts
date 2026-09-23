import { expect, test } from 'bun:test';

import { PROFILES } from './config.ts';
import { filesFor, loadManifest } from './manifest.ts';

// Ruling 33: filesFor() только фильтрует список канон-файлов — оно не замечает, если два
// файла манифеста целят в один и тот же dest внутри одного профиля. planFiles() в этом случае
// планирует оба, apply() пишет оба (побеждает последний в списке), и следующий план вечно видит
// дрейф по проигравшей записи. Гвард включает все with-группы разом, чтобы поймать дубликат, который
// проявляется только при определённой комбинации опциональных групп.
test('canon manifest: ни один профиль не получает два файла с одинаковым dest', () => {
	const manifest = loadManifest();
	const allGroups = [...new Set(manifest.map((f) => f.group).filter((g) => g != null))];
	for (const profile of PROFILES) {
		const dests = filesFor({ profile, with: allGroups, exceptions: [] }).map((f) => f.dest);
		const duplicates = dests.filter((dest, i) => dests.indexOf(dest) !== i);
		expect(duplicates).toEqual([]);
	}
});
