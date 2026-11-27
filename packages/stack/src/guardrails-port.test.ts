import { describe, expect, test } from 'bun:test';

import { spawnRunner } from './guardrails-port.ts';

// Окружение, которое тест передаёт spawnRunner параметром.
const SET = {
	HADOLINT_IGNORE: 'DL3025',
	HADOLINT_FORMAT: 'tty',
	YAMLLINT_CONFIG_FILE: '/x',
	SHELLCHECK_OPTS: '-e SC2086',
	GITLEAKS_CONFIG: '/gl.toml',
	GITLEAKS_CONFIG_TOML: 'title = "x"',
	UV_OFFLINE: '1',
	KEEP_ME: '1',
} as const;

function envOf(extra?: Record<string, string>): Map<string, string> {
	const r = spawnRunner(process.cwd(), { PATH: process.env.PATH ?? '', ...SET })(
		'env',
		[],
		undefined,
		extra,
	);
	expect(r.code).toBe(0);
	const out = new Map<string, string>();
	for (const line of r.out.split('\n')) {
		const i = line.indexOf('=');
		if (i > 0) out.set(line.slice(0, i), line.slice(i + 1));
	}
	return out;
}

describe('spawnRunner: окружение процесса', () => {
	test('HADOLINT_*, YAMLLINT_CONFIG_FILE и прежние три убраны, UV_* и прочее остались', () => {
		const env = envOf();
		for (const gone of [
			'HADOLINT_IGNORE',
			'HADOLINT_FORMAT',
			'YAMLLINT_CONFIG_FILE',
			'SHELLCHECK_OPTS',
			'GITLEAKS_CONFIG',
			'GITLEAKS_CONFIG_TOML',
		]) {
			expect(env.has(gone)).toBe(false);
		}
		expect(env.get('UV_OFFLINE')).toBe('1');
		expect(env.get('KEEP_ME')).toBe('1');
	});

	test('env вызова дописывается последним: бьёт process.env и очищенное окружение', () => {
		const env = envOf({ HOME: '/tmp/h', KEEP_ME: '2', HADOLINT_IGNORE: 'DL3000' });
		expect(env.get('HOME')).toBe('/tmp/h');
		expect(env.get('KEEP_ME')).toBe('2');
		// явно переданное переопределение не вычищается: чистится только окружение родителя
		expect(env.get('HADOLINT_IGNORE')).toBe('DL3000');
		expect(env.get('UV_OFFLINE')).toBe('1');
	});

	test('пары GIT_CONFIG_* на месте и env их не вытесняет без запроса', () => {
		const env = envOf();
		expect(Number(env.get('GIT_CONFIG_COUNT'))).toBeGreaterThanOrEqual(5);
		const over = envOf({ GIT_CONFIG_COUNT: '0' });
		expect(over.get('GIT_CONFIG_COUNT')).toBe('0');
	});

	test('переменная окружения процесса, которой нет в параметре, до дочернего процесса не доходит', () => {
		process.env.STACK_TEST_LEAK = 'from-process';
		try {
			expect(envOf().has('STACK_TEST_LEAK')).toBe(false);
		} finally {
			Reflect.deleteProperty(process.env, 'STACK_TEST_LEAK');
		}
	});
});
