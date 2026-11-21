import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { git, gitRepo, historyStep, isolateGitConfig, shallowPrCheckout } from './testkit.ts';

// Шаг history из check.yml на PR-checkout: историю догружают обе группы, которым она нужна.
describe('check.yml: история PR для групп guardrails и repo-rules', () => {
	let restore: () => void;
	const made: string[] = [];
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => {
		restore();
		for (const d of made) rmSync(d, { recursive: true, force: true });
	});

	const cfg = (withList: string[]): string =>
		`{ "with": [${withList.map((g) => `"${g}"`).join(', ')}] }\n`;

	// origin с PR: feature на коммит от main, main ушёл вперёд, merge-коммит в refs/pull/1/merge.
	function prOrigin(withList: string[]): string {
		const { dir, remote } = gitRepo({ '.stack.jsonc': cfg(withList), 'a.txt': 'a\n' });
		git(dir, 'checkout', '-b', 'feature');
		git(dir, 'commit', '--allow-empty', '-m', 'pr commit');
		git(dir, 'checkout', 'main');
		git(dir, 'commit', '--allow-empty', '-m', 'main moves on');
		git(dir, 'push', 'origin', 'main');
		git(dir, 'checkout', '--detach', 'main');
		git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge pr');
		git(dir, 'push', 'origin', 'HEAD:refs/pull/1/merge');
		git(remote, 'config', 'uploadpack.allowFilter', 'true');
		made.push(dir, remote);
		return remote;
	}

	function shallow(withList: string[]): string {
		const work = shallowPrCheckout(prOrigin(withList));
		made.push(work);
		return work;
	}

	const probe = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim();
	const mergeBase = (cwd: string): number => {
		try {
			git(cwd, 'merge-base', 'origin/main', 'HEAD');
			return 0;
		} catch {
			return 1;
		}
	};

	for (const withList of [['guardrails'], ['guardrails', 'repo-rules']]) {
		test(`with ${JSON.stringify(withList)}: мелкий checkout догружается до полного с origin/main`, () => {
			const work = shallow(withList);
			expect(probe(work, 'rev-parse', '--is-shallow-repository')).toBe('true');
			expect(historyStep(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository')).toBe('false');
			expect(probe(work, 'rev-parse', '--verify', 'origin/main')).toMatch(/^[0-9a-f]{40}$/);
			expect(mergeBase(work)).toBe(0);
		});
	}

	test('with []: клон остаётся мелким, origin/main нет', () => {
		const work = shallow([]);
		expect(historyStep(work).code).toBe(0);
		expect(probe(work, 'rev-parse', '--is-shallow-repository')).toBe('true');
		expect(() => git(work, 'rev-parse', '--verify', '-q', 'origin/main')).toThrow();
	});

	test('полный клон с guardrails: --unshallow не звался, ссылок не прибавилось', () => {
		const remote = prOrigin(['guardrails']);
		const work = mkdtempSync(join(tmpdir(), 'stack-full-'));
		made.push(work);
		git(work, 'clone', `file://${remote}`, '.');
		git(work, 'fetch', 'origin', '+refs/pull/1/merge:refs/remotes/pull/1/merge');
		git(work, 'checkout', '--force', 'refs/remotes/pull/1/merge');
		const refs = probe(work, 'for-each-ref');
		const s = historyStep(work);
		expect(s.code).toBe(0);
		expect(s.err).toBe('');
		expect(probe(work, 'rev-parse', '--is-shallow-repository')).toBe('false');
		expect(probe(work, 'for-each-ref')).toBe(refs);
	});

	test('контроль: тот же мелкий checkout без шага — merge-base не находится', () => {
		const work = shallow(['guardrails']);
		expect(mergeBase(work)).not.toBe(0);
	});
});
