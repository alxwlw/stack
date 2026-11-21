import { expect, test } from 'bun:test';

import type { Finding } from './findings.ts';
import { checkWorkflowHygiene } from './workflow-hygiene.ts';

const PATH = '.github/workflows/ci.yml';
const h = (text: string, path = PATH) => checkWorkflowHygiene(new Map([[path, text]]));
const msg = (message: string, path = PATH): Finding[] => [
	{ code: 'workflow-hygiene', target: path, message },
];

const ok = `on: push
permissions: { contents: read }
concurrency: ci
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps: [{ run: 'true' }]
`;

const bare = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`;

const ALL =
	'missing timeout-minutes (build); permissions (top level, or in build); concurrency (top level, or in build)';

test('полный workflow — чисто', () => {
	expect(h(ok)).toStrictEqual([]);
});

test('джобы без timeout-minutes — в порядке файла', () => {
	const text = `on: push
permissions: { contents: read }
concurrency: ci
jobs:
  test:
    runs-on: x
    steps: [{ run: 'true' }]
  build:
    runs-on: x
    steps: [{ run: 'true' }]
`;
	expect(h(text)).toStrictEqual(msg('missing timeout-minutes (test, build)'));
});

test.each([
	['uses', '    uses: ./.github/workflows/check.yml\n'],
	['uses и runs-on', '    runs-on: x\n    uses: ./.github/workflows/check.yml\n'],
])('джоб с uses: — timeout не нужен (%s)', (_name, body) => {
	const text = `on: push\npermissions: { contents: read }\nconcurrency: ci\njobs:\n  call:\n${body}`;
	expect(h(text)).toStrictEqual([]);
});

test('джоб с uses: проверяется на permissions и concurrency', () => {
	const text = `on: push\njobs:\n  call:\n    uses: ./.github/workflows/check.yml\n`;
	expect(h(text)).toStrictEqual(
		msg('missing permissions (top level, or in call); concurrency (top level, or in call)'),
	);
});

test('всё отсутствует', () => {
	expect(h(bare)).toStrictEqual(msg(ALL));
});

test.each(['permissions', 'concurrency'])('%s в одном джобе из двух', (key) => {
	const job = (id: string, own: boolean) =>
		`  ${id}:\n    runs-on: x\n    timeout-minutes: 5\n${own ? `    ${key}: ${key === 'permissions' ? '{}' : 'g'}\n` : ''}    steps: []\n`;
	const top = key === 'permissions' ? 'concurrency: c\n' : 'permissions: {}\n';
	const some = `on: push\n${top}jobs:\n${job('a', true)}${job('b', false)}`;
	expect(h(some)).toStrictEqual(msg(`missing ${key} (top level, or in b)`));
	const every = `on: push\n${top}jobs:\n${job('a', true)}${job('b', true)}`;
	expect(h(every)).toStrictEqual([]);
});

test.each([
	['on: workflow_call'],
	['on: [workflow_call]'],
	['on:\n  workflow_call:\n    inputs: {}'],
])('только workflow_call — concurrency не нужен (%s)', (on) => {
	const text = `${on}\npermissions: { contents: read }\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps: []\n`;
	expect(h(text)).toStrictEqual([]);
});

test.each([
	['on: [workflow_call, workflow_dispatch]'],
	['on: { workflow_call: {}, push: {} }'],
	['name: x'],
])('workflow_call и ещё триггер или нет on — concurrency нужен (%s)', (on) => {
	const text = `${on}\npermissions: { contents: read }\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps: []\n`;
	expect(h(text)).toStrictEqual(msg('missing concurrency (top level, or in build)'));
});

test.each([
	['permissions', 'permissions: {}'],
	['permissions', 'permissions: read-all'],
	['concurrency', 'concurrency: ci-${{ github.ref }}'],
])('значения не оцениваются (%s: %s)', (key, line) => {
	const text = ok
		.split('\n')
		.map((l) => (l.startsWith(`${key}:`) ? line : l))
		.join('\n');
	expect(h(text)).toStrictEqual([]);
});

test('timeout-minutes выражением — значение есть', () => {
	const text = ok.replace('timeout-minutes: 10', 'timeout-minutes: ${{ fromJSON(vars.T) }}');
	expect(h(text)).toStrictEqual([]);
});

test('пустое значение — ключа нет', () => {
	const text = `on: push
permissions:
concurrency:
jobs:
  build:
    runs-on: x
    timeout-minutes:
    steps: []
`;
	expect(h(text)).toStrictEqual(msg(ALL));
});

test('алиас целого джоба несёт ключи', () => {
	const text = `on: push
permissions: {}
concurrency: c
jobs:
  a: &base
    runs-on: x
    timeout-minutes: 5
    steps: []
  alt: *base
`;
	expect(h(text)).toStrictEqual([]);
});

test('<<: не сливает — ключ якоря не унаследован', () => {
	const text = `on: push
permissions: {}
concurrency: c
jobs:
  a: &base
    runs-on: x
    timeout-minutes: 5
    steps: []
  b:
    <<: *base
    steps: []
`;
	expect(h(text)).toStrictEqual(msg('missing timeout-minutes (b)'));
});

const bomb = (() => {
	const lines = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
	for (let i = 1; i <= 7; i += 1) {
		const prev = `*l${i - 1}`;
		lines.push(`l${i}: &l${i} [${Array.from({ length: 10 }, () => prev).join(', ')}]`);
	}
	return `${lines.join('\n')}\n`;
})();

test.each([
	['алиас без якоря', 'a: *missing\n'],
	['бомба алиасов', bomb],
])('неразборный файл — находка, не исключение (%s)', (_name, text) => {
	const found = h(text);
	expect(found).toHaveLength(1);
	expect(found[0]?.code).toBe('workflow-hygiene');
	expect(found[0]?.target).toBe(PATH);
	expect(found[0]?.message.startsWith('cannot read: ')).toBe(true);
	expect(found[0]?.message).not.toContain('\n');
});

test.each([
	['дубль ключа', 'permissions: {}\npermissions: {}\n'],
	['табы в отступах', 'jobs:\n\tbuild: {}\n'],
	['незакрытая кавычка', 'name: "abc\n'],
])('неразборный файл: ошибка парсера (%s)', (_name, text) => {
	const found = h(text);
	expect(found).toHaveLength(1);
	expect(found[0]?.message.startsWith('cannot read: ')).toBe(true);
	expect(found[0]?.message).not.toContain('\n');
});

test.each([[''], ['# только комментарий\n'], ['- a\n- b\n'], ['push\n']])(
	'корень не объект (%j)',
	(text) => {
		expect(h(text)).toStrictEqual(msg('cannot read: not a mapping'));
	},
);

test.each([
	['нет', ''],
	['null', 'jobs:\n'],
	['список', 'jobs: [a, b]\n'],
])('jobs: %s — джобов нет', (_name, jobs) => {
	const top = 'on: push\npermissions: {}\nconcurrency: c\n';
	expect(h(`${top}${jobs}`)).toStrictEqual([]);
	expect(h(`on: push\n${jobs}`)).toStrictEqual(
		msg('missing permissions (top level); concurrency (top level)'),
	);
});

test('джоб не объект — джоб без ключей', () => {
	const text = 'on: push\npermissions: {}\nconcurrency: c\njobs:\n  a:\n';
	expect(h(text)).toStrictEqual(msg('missing timeout-minutes (a)'));
});

test('какие файлы проверяются', () => {
	const files = new Map(
		[
			'.github/workflows/b.yaml',
			'.github/workflows/a.yml',
			'.github/workflows/sub/x.yml',
			'.github/actions/setup/action.yml',
			'ci.yml',
		].map((p) => [p, bare] as const),
	);
	expect(checkWorkflowHygiene(files)).toStrictEqual([
		...msg(ALL, '.github/workflows/a.yml'),
		...msg(ALL, '.github/workflows/b.yaml'),
	]);
});
