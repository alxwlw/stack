import { describe, expect, test } from 'bun:test';

import { focusedSkippedTests, numberOrDefault, suppressionReason } from './rules.mjs';
import { commentStart, familyOf } from './source.mjs';

const flagged = (hits: { line: number }[]): number[] => hits.map((h) => h.line);

describe('source', () => {
	test('familyOf', () => {
		expect(familyOf('a.tsx')).toBe('js');
		expect(familyOf('a.d.ts')).toBeNull();
		expect(familyOf('C.sol')).toBe('sol');
		expect(familyOf('x.py')).toBe('py');
		expect(familyOf('README.md')).toBeNull();
	});
	test('commentStart skips openers inside string literals', () => {
		expect(commentStart(`const u = 'http://x'; // real`, 'js')).toBe(22);
		expect(commentStart('const s = `/* no */`;', 'js')).toBe(-1);
		expect(commentStart(`s = "# no"  # yes`, 'py')).toBe(12);
		expect(commentStart('   * continuation', 'js')).toBe(3);
		expect(commentStart(`const q = 'it\\'s // no';`, 'js')).toBe(-1);
	});
});

describe('suppression-reason', () => {
	const js = (...src: string[]) => flagged(suppressionReason(src, 'js'));
	test('eslint/oxlint directives need « -- reason»', () => {
		expect(js('// eslint-disable-next-line no-console')).toEqual([1]);
		expect(js('// eslint-disable-next-line no-console -- CLI prints')).toEqual([]);
		expect(js('/* eslint-disable */')).toEqual([1]);
		expect(js('/* oxlint-disable no-x -- generated file */')).toEqual([]);
		expect(js('foo(); // oxlint-disable-line no-x')).toEqual([1]);
		expect(js('{/* eslint-disable-next-line @next/next/no-img-element */}')).toEqual([1]);
		expect(js(' * eslint-disable-next-line x')).toEqual([1]);
	});
	test('a reason shorter than three characters does not count', () => {
		expect(js('// eslint-disable-next-line x -- ok')).toEqual([1]);
		expect(js('// eslint-disable-next-line x -- why')).toEqual([]);
	});
	test('@ts-expect-error / @ts-ignore need trailing text', () => {
		expect(js('// @ts-expect-error')).toEqual([1]);
		expect(js('// @ts-expect-error wrong upstream types')).toEqual([]);
		expect(js('/* @ts-ignore */')).toEqual([1]);
		expect(js('// @ts-ignore: legacy shim')).toEqual([]);
	});
	test('biome-ignore needs text after the colon', () => {
		expect(js('// biome-ignore lint/style/noX:')).toEqual([1]);
		expect(js('// biome-ignore lint/style/noX: needed for Y')).toEqual([]);
	});
	test('prose, strings and *-enable are not directives', () => {
		expect(js('// we avoid eslint-disable here')).toEqual([]);
		expect(js(`const s = '// eslint-disable-next-line x';`)).toEqual([]);
		expect(js('/* eslint-enable */')).toEqual([]);
	});
	test('solhint', () => {
		expect(
			flagged(suppressionReason(['// solhint-disable-next-line no-empty-blocks'], 'sol')),
		).toEqual([1]);
		expect(
			flagged(suppressionReason(['/* solhint-disable -- vendored OZ copy */'], 'sol')),
		).toEqual([]);
		expect(flagged(suppressionReason(['// eslint-disable-line x'], 'sol'))).toEqual([]);
	});
	test('python noqa / type: ignore', () => {
		const py = (...src: string[]) => flagged(suppressionReason(src, 'py'));
		expect(py('import x  # noqa: E402')).toEqual([1]);
		expect(py('import x  # noqa: E402 -- path set above')).toEqual([]);
		expect(py('y = f()  # type: ignore[arg-type]')).toEqual([1]);
		expect(py('y = f()  # type: ignore -- stub lacks overload')).toEqual([]);
		expect(py(`s = "# noqa"`)).toEqual([]);
	});
	test('CRLF line endings keep the reason', () => {
		expect(js('// eslint-disable-line x -- legacy API\r')).toEqual([]);
		expect(js('// eslint-disable-line x\r')).toEqual([1]);
	});
});

describe('focused-skipped-tests', () => {
	const t = (...src: string[]) => flagged(focusedSkippedTests(src));
	test('.only always', () => {
		expect(t(`it.only('a', () => {});`)).toEqual([1]);
		expect(t(`describe.only.each([1])('a', () => {});`)).toEqual([1]);
		expect(t(`test.only('a', () => {}); // -- debugging`)).toEqual([1]);
	});
	test('.skip / .todo / x* without a reason', () => {
		expect(t(`it.skip('a', () => {});`)).toEqual([1]);
		expect(t(`test.todo('later');`)).toEqual([1]);
		expect(t(`xit('a', () => {});`)).toEqual([1]);
		expect(t(`xdescribe('a', () => {});`)).toEqual([1]);
		expect(t(`test.skip.each([1])('a', () => {});`)).toEqual([1]);
		expect(t('test.skip();')).toEqual([1]);
	});
	test('a reason on the same line or the comment line above', () => {
		expect(t(`it.skip('a', () => {}); // -- flaky upstream, MR-12`)).toEqual([]);
		expect(t('// -- needs a live node', `it.skip('a', () => {});`)).toEqual([]);
		expect(t('const x = 1; // -- not a comment line', `it.skip('a', () => {});`)).toEqual([2]);
	});
	test('CRLF on a focused/skipped line keeps its reason', () => {
		expect(t(`it.skip('a', () => {}); // -- flaky upstream, MR-12\r`)).toEqual([]);
		expect(t(`it.skip('a', () => {});\r`)).toEqual([1]);
	});
	test('conditional skips are allowed', () => {
		expect(t(`it.skipIf(!process.env.DB)('a', () => {});`)).toEqual([]);
		expect(t(`test.runIf(ci)('a', () => {});`)).toEqual([]);
		expect(t('test.skip(!gate.ok, gate.reason);')).toEqual([]);
		expect(t('test.skip(', '  debt > 0n,', "  'blocked',", ');')).toEqual([]);
	});
	test('other identifiers and comments are ignored', () => {
		expect(t('list.skip(2);')).toEqual([]);
		expect(t(`// it.only('a')`)).toEqual([]);
	});
});

describe('number-or-default', () => {
	const n = (...src: string[]) => flagged(numberOrDefault(src));
	test('a non-zero literal after the call', () => {
		expect(n('const p = Number(process.env.PORT) || 5757;')).toEqual([1]);
		expect(n('priority: parseInt(priority, 10) || 100,')).toEqual([1]);
		expect(n(`const v = Number.parseFloat(q.replace(',', '.')) || 1.5;`)).toEqual([1]);
		expect(n(`const s = parseFloat(x) || 'n/a';`)).toEqual([1]);
		expect(n('const s = Number(x) || null;')).toEqual([1]);
	});
	test('`|| 0`, variables, `??` and other calls are left alone', () => {
		expect(n('const d = parseFloat(css) || 0;')).toEqual([]);
		expect(n('const d = Number(x) || -0;')).toEqual([]);
		expect(n('const d = Number(x) || fallback;')).toEqual([]);
		expect(n('const d = Number(x) ?? 4;')).toEqual([]);
		expect(n('const d = obj.parseInt(x) || 4;')).toEqual([]);
		expect(n('const d = myNumber(x) || 4;')).toEqual([]);
	});
	test('parentheses and strings inside the call', () => {
		expect(n(`const l = Number(row.l.replace(/[^\\d.]/g, '')) || 1`)).toEqual([1]);
		expect(n(`const l = Number(f(')')) || 7;`)).toEqual([1]);
		expect(n('const l = Number(', '  x) || 7;')).toEqual([]);
	});
	test('a call in a comment is ignored', () => {
		expect(n('// Number(x) || 7')).toEqual([]);
	});
});
