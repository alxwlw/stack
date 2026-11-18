import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
	type GitHub,
	type NewPr,
	type OpenPr,
	publishChanges,
	type PublishOptions,
} from './sync-pr.ts';

export const PR_URL = 'https://github.com/acme/app/pull/1';

export function botPr(
	number: number,
	version: string,
	base = 'main',
	author = 'acme-bot[bot]',
): OpenPr {
	return {
		number,
		url: `https://github.com/acme/app/pull/${number}`,
		head: `stack/v${version}`,
		base,
		author,
	};
}

// open — изменяемый список открытых PR: createPr добавляет свой, closePr убирает закрытый.
export function fakeGitHub(
	over: Partial<GitHub> = {},
	initial: readonly OpenPr[] = [],
): {
	github: GitHub;
	calls: string[];
	created: NewPr[];
	closed: [number, string][];
	open: OpenPr[];
} {
	const calls: string[] = [];
	const created: NewPr[] = [];
	const closed: [number, string][] = [];
	const open: OpenPr[] = [...initial];
	const github: GitHub = {
		botUserId: () => {
			calls.push('botUserId');
			return Promise.resolve(42);
		},
		createPr: (pr) => {
			calls.push('createPr');
			created.push(pr);
			open.push({
				number: 100,
				url: PR_URL,
				head: pr.head,
				base: pr.base ?? '',
				author: 'acme-bot[bot]',
			});
			return Promise.resolve(PR_URL);
		},
		defaultBranch: () => {
			calls.push('defaultBranch');
			return Promise.resolve('main');
		},
		openPrs: () => {
			calls.push('openPrs');
			return Promise.resolve([...open]);
		},
		closePr: (number, comment) => {
			calls.push('closePr');
			closed.push([number, comment]);
			const i = open.findIndex((p) => p.number === number);
			if (i >= 0) open.splice(i, 1);
			return Promise.resolve();
		},
		...over,
	};
	return { github, calls, created, closed, open };
}

export function put(dir: string, path: string, content: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

export async function run(
	opts: PublishOptions,
	github: GitHub,
): Promise<{ code: 0 | 1; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await publishChanges(opts, github, (stream, line) =>
		(stream === 'out' ? out : err).push(line),
	);
	return { code, out, err };
}

export const opts = (dir: string, over: Partial<PublishOptions> = {}): PublishOptions => ({
	repoRoot: dir,
	version: '1.2.3',
	appSlug: 'acme-bot',
	...over,
});
