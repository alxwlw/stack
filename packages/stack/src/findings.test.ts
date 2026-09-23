import { expect, test } from 'bun:test';

import type { Exception } from './config.ts';
import { applyExceptions, type Finding } from './findings.ts';

const finding = (over: Pick<Finding, 'code' | 'target'> & Partial<Finding>): Finding => ({
	message: 'm',
	...over,
});

const drift = finding({
	code: 'file-drift',
	target: '.editorconfig',
	address: { file: '.editorconfig' },
});
const missing = finding({
	code: 'file-missing',
	target: '.gitleaks.toml',
	address: { file: '.gitleaks.toml' },
});
const devReact = finding({
	code: 'catalog-drift',
	target: 'catalogs.dev.react',
	address: { catalog: 'dev', name: 'react' },
});
const libsReact = finding({
	code: 'catalog-missing',
	target: 'catalogs.libs.react',
	address: { catalog: 'libs', name: 'react' },
});
const inlineReact = finding({
	code: 'inline-version',
	target: 'packages/app/package.json:react',
	address: { name: 'react' },
});
const inlineZod = finding({
	code: 'inline-version',
	target: 'packages/app/package.json:zod',
	address: { name: 'zod' },
});
const dependabot = finding({ code: 'dependabot-ignore', target: '.github/dependabot.yml' });
const engines = finding({ code: 'engines-node', target: 'package.json:engines.node' });
const unreadable = finding({ code: 'unreadable-file', target: 'packages/app/package.json' });

const onEditorconfig: Exception = { file: '.editorconfig', reason: 'исторический отступ' };
const onGitleaks: Exception = { file: '.gitleaks.toml', reason: 'временно без файла' };
const onLibsReact: Exception = { catalog: 'libs', name: 'react', reason: 'миграция с React 18' };

// Каждая строка проверяет обе стороны одного решения: находка получает suppressedBy тогда и
// только тогда, когда исключение не считается протухшим.
const table: [string, Finding, Exception, boolean][] = [
	['file гасит file-drift своего файла', drift, onEditorconfig, true],
	['file гасит file-missing своего файла', missing, onGitleaks, true],
	['file не гасит другой файл', missing, onEditorconfig, false],
	['file не гасит запись каталога', devReact, onEditorconfig, false],
	['file не гасит inline-version', inlineReact, onEditorconfig, false],
	['catalog+name гасит свою запись каталога', libsReact, onLibsReact, true],
	['catalog+name не гасит тот же пакет в другом каталоге', devReact, onLibsReact, false],
	[
		'catalog+name гасит inline-version того же пакета из любого каталога',
		inlineReact,
		onLibsReact,
		true,
	],
	['catalog+name не гасит inline-version другого пакета', inlineZod, onLibsReact, false],
	['catalog+name не гасит файл', drift, onLibsReact, false],
	[
		'dependabot-ignore без адреса не гасится даже при совпадении target с file',
		dependabot,
		{ file: '.github/dependabot.yml', reason: 'r' },
		false,
	],
	[
		'engines-node без адреса не гасится даже при совпадении target с file',
		engines,
		{ file: 'package.json:engines.node', reason: 'r' },
		false,
	],
	[
		'unreadable-file без адреса не гасится даже при совпадении target с file',
		unreadable,
		{ file: 'packages/app/package.json', reason: 'r' },
		false,
	],
];

test.each(table)('%s', (_name, f, e, covered) => {
	const out = applyExceptions([f], [e]);
	const same = out.find((x) => x.code === f.code && x.target === f.target);
	expect(same?.suppressedBy).toEqual(covered ? e : undefined);
	expect(out.filter((x) => x.code === 'stale-exception')).toHaveLength(covered ? 0 : 1);
});

test('одно исключение catalog+name гасит и запись каталога, и inline-version — и не протухает', () => {
	const out = applyExceptions([libsReact, inlineReact, inlineZod], [onLibsReact]);
	expect(out.map((f) => [f.target, f.suppressedBy?.reason])).toEqual([
		['catalogs.libs.react', 'миграция с React 18'],
		['packages/app/package.json:react', 'миграция с React 18'],
		['packages/app/package.json:zod', undefined],
	]);
});

test('протухшее исключение — находка с адресом исключения и его причиной в сообщении', () => {
	const out = applyExceptions([drift], [onEditorconfig, onGitleaks, onLibsReact]);
	expect(out.map((f) => [f.code, f.target])).toEqual([
		['file-drift', '.editorconfig'],
		['stale-exception', '.gitleaks.toml'],
		['stale-exception', 'catalogs.libs.react'],
	]);
	expect(out[1]?.message).toBe('exception no longer covers anything: временно без файла');
	expect(out[2]?.message).toBe('exception no longer covers anything: миграция с React 18');
});

test('копия исключения гасит так же, как оригинал: решение по содержимому, не по ссылке', () => {
	const out = applyExceptions([drift], [{ ...onEditorconfig }]);
	expect(out).toHaveLength(1);
	expect(out[0]?.suppressedBy).toEqual(onEditorconfig);
});
