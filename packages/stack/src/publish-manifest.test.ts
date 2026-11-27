/**
 * npm normalises the manifest it sends to the registry, and it does so SILENTLY apart from one
 * warning line. A `bin` value written as `./src/cli.ts` is dropped entirely — the published
 * package then has no `stack` executable at all, breaking both the README quick start and the
 * `stack check` step of the reusable CI workflow. Caught for real on the first publish attempt
 * of 1.0.0; the warning text names the already-stripped value, not the leading `./` that causes
 * it, so it is easy to misread.
 *
 * This asserts on the general class, not on today's rule: any manifest npm feels the need to
 * auto-correct fails the suite before it can reach the registry.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parseAllDocuments } from 'yaml';

import { releasePackages } from '../../../scripts/release.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

// Derived, not listed (DP-027): a package directory under packages/ joins this gate on its own.
const packages = releasePackages(ROOT).map((p) => p.dir);

test('the manifest gate finds the workspace packages', () => {
	expect(packages.length).toBeGreaterThan(0);
});

for (const pkg of packages) {
	test(`npm не правит манифест @alxwlw/${pkg} при публикации`, () => {
		const res = spawnSync('npm', ['publish', '--dry-run', '--provenance=false'], {
			cwd: join(ROOT, 'packages', pkg),
			encoding: 'utf8',
		});
		const out = `${res.stdout}${res.stderr}`;
		// `--dry-run` всё равно ходит в реестр, поэтому после релиза он отвечает «нельзя
		// опубликовать поверх уже опубликованной версии». Это ожидаемое состояние всех версий
		// между релизами, а не дефект манифеста: терпим ровно эту ошибку и никакую другую.
		const alreadyPublished = out.includes('cannot publish over the previously published');
		if (!alreadyPublished) expect(res.status).toBe(0);

		const corrections = out
			.split('\n')
			.filter((l) => l.includes('auto-corrected') || l.includes('was invalid and removed'));
		expect(corrections).toEqual([]);
		// Таймаут 30 с: npm ходит в реестр, на CI-раннере это упирается в 5 с по умолчанию.
	}, 30_000);
}

test('repo-rules импортируется по имени пакета: main и run', async () => {
	const m = (await import('@alxwlw/repo-rules')) as Record<string, unknown>;
	expect(Object.keys(m).sort()).toStrictEqual(['main', 'run']);
});

test('lockfile связывает repo-rules из workspace, а не из реестра', () => {
	type Lock = {
		importers: Record<
			string,
			{ dependencies?: Record<string, { specifier: string; version: string }> }
		>;
	};
	// pnpm 12 пишет lockfile из двух документов: окружение (packageManager) и проект; нужен второй.
	const docs = parseAllDocuments(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).map(
		(d) => d.toJS() as Lock,
	);
	const lock = docs.find((d) => d.importers['packages/stack'] !== undefined);
	const own = JSON.parse(readFileSync(join(ROOT, 'packages/stack/package.json'), 'utf8')) as {
		version: string;
	};
	expect(lock?.importers['packages/stack']?.dependencies?.['@alxwlw/repo-rules']).toStrictEqual({
		specifier: own.version,
		version: 'link:../repo-rules',
	});
});

test('markdownlint-cli2 — точная зависимость stack, раннер входит в публикуемые файлы', () => {
	const own = JSON.parse(readFileSync(join(ROOT, 'packages/stack/package.json'), 'utf8')) as {
		dependencies: Record<string, string>;
	};
	expect(own.dependencies['markdownlint-cli2']).toMatch(/^\d+\.\d+\.\d+$/);
	const res = spawnSync('npm', ['publish', '--dry-run', '--provenance=false'], {
		cwd: join(ROOT, 'packages', 'stack'),
		encoding: 'utf8',
	});
	const out = `${res.stdout}${res.stderr}`;
	expect(out).toContain('src/markdownlint-run.ts');
	expect(out).toContain('src/markdownlint-run.bunfig.toml');
}, 30_000);

test('в тарболл stack не попадают помощники тестов и сами тесты', () => {
	const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: join(ROOT, 'packages', 'stack'),
		encoding: 'utf8',
	});
	expect(res.status).toBe(0);
	const packed = (JSON.parse(res.stdout) as { files: { path: string }[] }[])[0]?.files ?? [];
	const paths = packed.map((f) => f.path);
	// Положительный контроль: список непустой и содержит исходники.
	expect(paths).toContain('src/cli.ts');
	expect(paths.filter((p) => /(^|\/)testkit[^/]*\.ts$/.test(p) || p.endsWith('.test.ts'))).toEqual(
		[],
	);
}, 30_000);
