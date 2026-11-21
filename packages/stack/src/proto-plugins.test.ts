import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { canonFile, ROOT } from './testkit.ts';

// Связь трёх мест: [plugins] канонного prototools, файлы плагинов в canon/files/proto-plugins и записи
// manifest.json. Рассинхрон между ними даёт пин, который proto не умеет поставить, или файл, который sync не кладёт.
const CANON = join(ROOT, 'packages', 'stack', 'canon');
const PLUGIN_DIR = join(CANON, 'files', 'proto-plugins');
const ROOT_PLUGIN_DIR = join(ROOT, '.moon', 'proto-plugins');

type ManifestEntry = { src: string; dest: string; appliesTo: string[] };

const prototools = readFileSync(join(CANON, 'files', 'prototools'), 'utf8');
const plugins = (Bun.TOML.parse(prototools) as { plugins?: Record<string, string> }).plugins ?? {};
const pins = parsePins(prototools);
const manifest = JSON.parse(readFileSync(join(CANON, 'manifest.json'), 'utf8')) as {
	files: ManifestEntry[];
};
const tomlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.toml'));
const tools = Object.keys(plugins);

describe('proto-плагины канона', () => {
	test('[plugins] канона не пуст', () => {
		expect(tools.length).toBeGreaterThan(0);
	});

	describe.each(tools)('%s', (tool) => {
		test('запись [plugins] указывает на вендоренный файл', () => {
			expect(plugins[tool]).toBe(`file://./.moon/proto-plugins/${tool}.toml`);
		});

		test('файл плагина есть, его name — этот инструмент', () => {
			const parsed = Bun.TOML.parse(readFileSync(join(PLUGIN_DIR, `${tool}.toml`), 'utf8')) as {
				name: string;
			};
			// Регистр имени у плагинов разный (ShellCheck, Gitleaks): proto сопоставляет по ключу [plugins].
			expect(parsed.name.toLowerCase()).toBe(tool);
		});

		test('пин инструмента есть в каноне', () => {
			expect(pins[tool]).toBeString();
		});

		test('манифест держит ровно одну запись, как у prototools', () => {
			const dest = `.moon/proto-plugins/${tool}.toml`;
			const entries = manifest.files.filter((f) => f.dest === dest);
			const own = manifest.files.find((f) => f.src === 'files/prototools');
			expect(entries).toHaveLength(1);
			expect(entries[0]?.src).toBe(`files/proto-plugins/${tool}.toml`);
			expect(entries[0]?.appliesTo).toStrictEqual(own?.appliesTo);
		});
	});

	test('каждый файл каталога плагинов назван в [plugins]', () => {
		expect(tomlFiles(PLUGIN_DIR).sort()).toStrictEqual(tools.map((t) => `${t}.toml`).sort());
	});

	test('каждая запись манифеста в proto-plugins назвала файл каталога', () => {
		const srcs = manifest.files.filter((f) => f.src.startsWith('files/proto-plugins/'));
		expect(srcs.map((f) => f.src).sort()).toStrictEqual(
			tomlFiles(PLUGIN_DIR)
				.map((f) => `files/proto-plugins/${f}`)
				.sort(),
		);
	});

	test('hadolint: плагин и пин в каноне', () => {
		expect(plugins.hadolint).toBeString();
		expect(pins.hadolint).toBeString();
	});
});

describe('корень stack ест свой канон', () => {
	test('[plugins] корневого .prototools равен канонным', () => {
		const rootProtools = readFileSync(join(ROOT, '.prototools'), 'utf8');
		const rootPlugins = (Bun.TOML.parse(rootProtools) as { plugins?: Record<string, string> })
			.plugins;
		expect(rootPlugins).toStrictEqual(plugins);
	});

	test('файлы .moon/proto-plugins побайтно равны канонным, лишних нет', () => {
		expect(tomlFiles(ROOT_PLUGIN_DIR).sort()).toStrictEqual(tools.map((t) => `${t}.toml`).sort());
		for (const tool of tools) {
			expect(readFileSync(join(ROOT_PLUGIN_DIR, `${tool}.toml`), 'utf8')).toBe(
				canonFile(`.moon/proto-plugins/${tool}.toml`),
			);
		}
	});
});
