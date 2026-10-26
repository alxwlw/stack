import { expect, test } from 'bun:test';

import type { Exception } from './config.ts';
import { addressOf, allowedLine, resolve } from './exceptions.ts';
import type { Finding } from './findings.ts';

const drift: Finding = {
	code: 'file-drift',
	target: '.editorconfig',
	message: 'm',
	file: '.editorconfig',
};
const missing: Finding = {
	code: 'file-missing',
	target: '.gitleaks.toml',
	message: 'm',
	file: '.gitleaks.toml',
};
const devReact: Finding = {
	code: 'catalog-drift',
	target: 'catalogs.dev.react',
	message: 'm',
	catalog: 'dev',
	name: 'react',
};
const libsReact: Finding = {
	code: 'catalog-missing',
	target: 'catalogs.libs.react',
	message: 'm',
	catalog: 'libs',
	name: 'react',
};
const inlineReact: Finding = {
	code: 'inline-version',
	target: 'packages/app/package.json:react',
	message: 'm',
	name: 'react',
};
const inlineZod: Finding = {
	code: 'inline-version',
	target: 'packages/app/package.json:zod',
	message: 'm',
	name: 'zod',
};
const pm: Finding = {
	code: 'package-manager',
	target: 'package.json:packageManager',
	message: 'm',
};
const staleF: Finding = { code: 'stale-exception', target: '.prototools', message: 'm' };
const dependabot: Finding = {
	code: 'dependabot-config',
	target: '.github/dependabot.yml',
	message: 'm',
};
const engines: Finding = {
	code: 'engines-node',
	target: 'package.json:engines.node',
	message: 'm',
};
const unreadable: Finding = {
	code: 'unreadable-file',
	target: 'packages/app/package.json',
	message: 'm',
};

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
		'dependabot-config неподавляема и не гасится даже при совпадении target с file',
		dependabot,
		{ file: '.github/dependabot.yml', reason: 'r' },
		false,
	],
	[
		'engines-node неподавляема и не гасится даже при совпадении target с file',
		engines,
		{ file: 'package.json:engines.node', reason: 'r' },
		false,
	],
	[
		'unreadable-file неподавляема и не гасится даже при совпадении target с file',
		unreadable,
		{ file: 'packages/app/package.json', reason: 'r' },
		false,
	],
	[
		'package-manager гасится исключением на .prototools',
		pm,
		{ file: '.prototools', reason: 'r' },
		true,
	],
	[
		'package-manager не гасится исключением на package.json',
		pm,
		{ file: 'package.json', reason: 'r' },
		false,
	],
];

const flat = (fs: Finding[], es: Exception[]): Finding[] => {
	const r = resolve(fs, es);
	return [...r.findings, ...r.stale];
};

test.each(table)('%s', (_name, f, e, covered) => {
	const r = resolve([f], [e]);
	const out = [...r.findings, ...r.stale];
	const same = out.find((x) => x.code === f.code && x.target === f.target);
	expect(same?.suppressedBy).toEqual(covered ? e : undefined);
	expect(out.filter((x) => x.code === 'stale-exception')).toHaveLength(covered ? 0 : 1);
});

test('одно исключение catalog+name гасит и запись каталога, и inline-version — и не протухает', () => {
	const out = flat([libsReact, inlineReact, inlineZod], [onLibsReact]);
	expect(out.map((f) => [f.target, f.suppressedBy?.reason])).toEqual([
		['catalogs.libs.react', 'миграция с React 18'],
		['packages/app/package.json:react', 'миграция с React 18'],
		['packages/app/package.json:zod', undefined],
	]);
});

test('протухшее исключение — находка с адресом исключения и его причиной в сообщении', () => {
	const out = flat([drift], [onEditorconfig, onGitleaks, onLibsReact]);
	expect(out.map((f) => [f.code, f.target])).toEqual([
		['file-drift', '.editorconfig'],
		['stale-exception', '.gitleaks.toml'],
		['stale-exception', 'catalogs.libs.react'],
	]);
	expect(out[1]?.message).toBe('exception no longer covers anything: временно без файла');
	expect(out[2]?.message).toBe('exception no longer covers anything: миграция с React 18');
});

test('копия исключения гасит так же, как оригинал: решение по содержимому, не по ссылке', () => {
	const out = flat([drift], [{ ...onEditorconfig }]);
	expect(out).toHaveLength(1);
	expect(out[0]?.suppressedBy).toEqual(onEditorconfig);
});

// Раньше протухшим считалось всё, что не вернул find: второе из двух исключений на одну находку
// шло в stale-exception. Теперь протухшесть — «не покрывает ни одной находки», и оба покрывают.
test('два исключения на одну находку: гасит первое, второе не считается протухшим', () => {
	const twin: Exception = { ...onEditorconfig, reason: 'второе оправдание' };
	const out = flat([drift], [onEditorconfig, twin]);
	expect(out.map((f) => [f.code, f.suppressedBy?.reason])).toEqual([
		['file-drift', 'исторический отступ'],
	]);
});

test('allowedLine печатает причину, цель и сообщение удержанной находки', () => {
	expect(allowedLine({ ...drift, suppressedBy: onEditorconfig })).toBe(
		'allowed (исторический отступ): .editorconfig — m',
	);
});

test('адрес находки строит таблица: предмет в адрес, неподавляемая — без адреса', () => {
	expect(addressOf(drift)).toEqual({ file: '.editorconfig' });
	expect(addressOf(devReact)).toEqual({ catalog: 'dev', name: 'react' });
	expect(addressOf(inlineReact)).toEqual({ name: 'react' });
	expect(addressOf(pm)).toEqual({ file: '.prototools' });
	expect(addressOf(engines)).toBeUndefined();
});

test('stale-exception не гасится ничем: сама находка остаётся, исключение тоже протухает', () => {
	const r = resolve([staleF], [{ file: '.prototools', reason: 'r' }]);
	expect(r.findings).toEqual([staleF]);
	expect(r.stale.map((f) => f.target)).toEqual(['.prototools']);
});
