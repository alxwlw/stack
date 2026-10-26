import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const SELF = relative(ROOT, import.meta.path);

// В тестах пакетов `docs/*.md` — данные фикстур модельного репозитория потребителя
// (их спеки и планы), а не ссылки на документы этого репозитория.
const FIXTURE_TESTS = /^packages\/.+\.test\.ts$/;

function trackedFiles(): string[] {
	const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
	return out
		.split('\n')
		.filter((f) => f.length > 0)
		.filter((f) => f !== SELF) // примеры шаблонов в именах тестов этого файла — не ссылки
		.filter((f) => !FIXTURE_TESTS.test(f));
}

function textOf(file: string): string | undefined {
	try {
		return readFileSync(join(ROOT, file), 'utf8');
	} catch {
		return undefined; // нечитаемый (бинарный) файл — не ссылка
	}
}

test('каждая ссылка на docs/*.md ведёт в существующий файл', () => {
	const broken: string[] = [];
	for (const file of trackedFiles()) {
		const text = textOf(file);
		if (text === undefined) continue;
		for (const m of text.matchAll(/\bdocs\/[\w./-]+\.md\b/g)) {
			if (!existsSync(join(ROOT, m[0]))) broken.push(`${file}: ${m[0]}`);
		}
	}
	expect(broken).toEqual([]);
});

test('каждая ссылка «docs/release.md, «раздел»» называет существующий заголовок', () => {
	const release = readFileSync(join(ROOT, 'docs', 'release.md'), 'utf8');
	const headings = new Set([...release.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]));
	const broken: string[] = [];
	let checked = 0;
	for (const file of trackedFiles()) {
		const text = textOf(file);
		if (text === undefined) continue;
		for (const m of text.matchAll(/docs\/release\.md, «([^»]+)»/g)) {
			checked += 1;
			if (!headings.has(m[1])) broken.push(`${file}: «${m[1]}»`);
		}
	}
	expect(broken).toEqual([]);
	// Контроль: без ссылок тест прошёл бы вхолостую.
	expect(checked).toBeGreaterThan(0);
});
