import { expect, test } from 'bun:test';

import type { Held } from './exceptions.ts';
import type { Drift, Finding } from './findings.ts';
import {
	allowedLine,
	checkOutput,
	findingLine,
	fixHint,
	type Line,
	printLines,
	syncOutput,
} from './output.ts';

const drift: Drift = {
	code: 'file-drift',
	file: 'a.txt',
	target: 'a.txt',
	message: 'm',
	fix: 'fixed a.txt',
	change: { file: 'a.txt', kind: 'write', content: 'x' },
};
const byHand: Finding = {
	code: 'dependabot-config',
	target: '.github/dependabot.yml',
	message: 'move to Renovate',
};
const held: Held<Drift> = {
	...drift,
	file: 'b.txt',
	target: 'b.txt',
	suppressedBy: { file: 'b.txt', reason: 'нужен свой' },
};
const err = (text: string): Line => ({ stream: 'err', text });
const out = (text: string): Line => ({ stream: 'out', text });

test('findingLine: код, цель и сообщение', () => {
	expect(findingLine(byHand)).toBe('dependabot-config: .github/dependabot.yml — move to Renovate');
});

test('allowedLine печатает причину, цель и сообщение удержанной находки', () => {
	expect(
		allowedLine({
			...drift,
			target: '.editorconfig',
			suppressedBy: { file: '.editorconfig', reason: 'исторический отступ' },
		}),
	).toBe('allowed (исторический отступ): .editorconfig — m');
});

test.each<[string, Finding[], string]>([
	['всё чинит sync', [drift, drift], '2 finding(s). Fix with: stack sync'],
	[
		'sync не чинит ничего',
		[byHand],
		'1 finding(s). stack sync does not fix these — fix them by hand (see above)',
	],
	[
		'смесь',
		[drift, drift, byHand],
		'3 finding(s): 2 fixable with: stack sync, 1 to fix by hand (see above)',
	],
])('fixHint: %s', (_name, blocking, hint) => {
	expect(fixHint(blocking)).toBe(hint);
});

test('checkOutput: пометки, удержанные, блокирующие, пустая строка, подсказка — всё в err, код 1', () => {
	expect(
		checkOutput({ findings: [held, drift, byHand], notes: ['note a', 'note b'] }),
	).toStrictEqual({
		code: 1,
		lines: [
			err('note a'),
			err('note b'),
			err('allowed (нужен свой): b.txt — m'),
			err('file-drift: a.txt — m'),
			err('dependabot-config: .github/dependabot.yml — move to Renovate'),
			err(''),
			// удержанная находка в числа подсказки не входит
			err('2 finding(s): 1 fixable with: stack sync, 1 to fix by hand (see above)'),
		],
	});
});

test('checkOutput: блокирующих нет — пометки и удержанные в err, no drift в out, код 0', () => {
	expect(checkOutput({ findings: [held], notes: ['note'] })).toStrictEqual({
		code: 0,
		lines: [err('note'), err('allowed (нужен свой): b.txt — m'), out('canon: no drift')],
	});
});

test('syncOutput: удержанные — в err, затем правки и итог — в out', () => {
	expect(syncOutput({ applied: [drift], held: [held] })).toStrictEqual([
		err(allowedLine(held)),
		out('fixed a.txt'),
		out('canon applied'),
	]);
	expect(syncOutput({ applied: [], held: [] })).toStrictEqual([out('canon already up to date')]);
});

test('printLines выпускает строки по порядку, каждую в свой канал', () => {
	const seen: Line[] = [];
	printLines((stream, text) => void seen.push({ stream, text }), [err('a'), out('b'), err('c')]);
	expect(seen).toStrictEqual([err('a'), out('b'), err('c')]);
});
