// Порт группы repo-rules: один вызов `main` из @alxwlw/repo-rules с захваченным выводом, какие вызовы
// делать и как читать их исход. Правило группы — repo-rules-rule.ts; здесь только значения и разбор.

/** Один вызов `main` repo-rules: код выхода и захваченные строки, склеенные через `\n`. */
export interface RepoRulesRun {
	code: number;
	out: string;
	err: string;
}
/** Порт: вызов repo-rules в процессе. Сбой repo-rules — не исключение, а код 2 в ответе. */
export type RepoRulesReader = (argv: string[], env: NodeJS.ProcessEnv) => RepoRulesRun;
/** Порт вместе с входами вызова: окружение и значение `--base`. */
export interface RepoRulesPort {
	read: RepoRulesReader;
	env: NodeJS.ProcessEnv;
	base: string | undefined;
}

export interface RepoRulesViolation {
	rule: string;
	path: string;
	line: number;
	message: string;
}
export interface RepoRulesStale {
	rule: string;
	path: string;
	baseline: number;
	actual: number;
}
export interface RepoRulesReport {
	violations: RepoRulesViolation[];
	stale: RepoRulesStale[];
	notes: string[];
}
export type RepoRulesPart = RepoRulesReport | { unavailable: string };
export interface RepoRulesOutcome {
	check: RepoRulesPart;
	diff: RepoRulesPart | { skipped: string };
}

export const DIFF_SKIPPED_NO_BASE = 'skipped (no --base outside GitHub Actions)';

const ERROR_PREFIX = 'repo-rules: ';

// Тот же предикат, что у repo-rules (diff.mjs): без --base diff зовётся только в GitHub Actions.
export function repoRulesCalls(
	repoRoot: string,
	base: string | undefined,
	env: NodeJS.ProcessEnv,
): { check: string[]; diff: string[] | undefined } {
	const check = ['-C', repoRoot, 'check', '--json'];
	const diff = ['-C', repoRoot, 'diff', '--json'];
	if (base !== undefined && base !== '') return { check, diff: [...diff, '--base', base] };
	return { check, diff: env.GITHUB_ACTIONS === 'true' ? diff : undefined };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function violationOf(v: unknown): RepoRulesViolation | undefined {
	if (!isRecord(v)) return undefined;
	const { rule, path, line, message } = v;
	if (typeof rule !== 'string' || typeof path !== 'string') return undefined;
	if (typeof line !== 'number' || typeof message !== 'string') return undefined;
	return { rule, path, line, message };
}

function staleOf(v: unknown): RepoRulesStale | undefined {
	if (!isRecord(v)) return undefined;
	const { rule, path, baseline, actual } = v;
	if (typeof rule !== 'string' || typeof path !== 'string') return undefined;
	if (typeof baseline !== 'number' || typeof actual !== 'number') return undefined;
	return { rule, path, baseline, actual };
}

// Список целиком или undefined: один негодный элемент делает негодным весь ответ.
function listOf<T>(v: unknown, one: (x: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: T[] = [];
	for (const x of v) {
		const item = one(x);
		if (item === undefined) return undefined;
		out.push(item);
	}
	return out;
}

const noteOf = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

export function repoRulesPart(run: RepoRulesRun): RepoRulesPart {
	if (run.code !== 0 && run.code !== 1) {
		const first = run.err.split('\n').find((l) => l.trim() !== '');
		if (first === undefined) return { unavailable: `exited with ${run.code}` };
		return {
			unavailable: first.startsWith(ERROR_PREFIX) ? first.slice(ERROR_PREFIX.length) : first,
		};
	}
	let data: unknown;
	try {
		data = JSON.parse(run.out);
	} catch {
		return { unavailable: 'output is not JSON' };
	}
	if (!isRecord(data)) return { unavailable: 'output has an unexpected shape: not an object' };
	const violations = listOf(data.violations, violationOf);
	if (violations === undefined)
		return { unavailable: 'output has an unexpected shape: violations' };
	const stale = listOf(data.stale, staleOf);
	if (stale === undefined) return { unavailable: 'output has an unexpected shape: stale' };
	const notes = listOf(data.notes, noteOf);
	if (notes === undefined) return { unavailable: 'output has an unexpected shape: notes' };
	// Код 1 без нарушений и без устаревших записей — ответ, которому нельзя верить как «чисто».
	if (run.code === 1 && violations.length === 0 && stale.length === 0) {
		return { unavailable: 'exited with 1 and reported nothing' };
	}
	return { violations, stale, notes };
}

export function readRepoRules(repoRoot: string, port: RepoRulesPort): RepoRulesOutcome {
	const calls = repoRulesCalls(repoRoot, port.base, port.env);
	const check = repoRulesPart(port.read(calls.check, port.env));
	if (calls.diff === undefined) return { check, diff: { skipped: DIFF_SKIPPED_NO_BASE } };
	return { check, diff: repoRulesPart(port.read(calls.diff, port.env)) };
}
