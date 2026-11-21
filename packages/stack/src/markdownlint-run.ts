// Раннер markdownlint-cli2 для группы guardrails: запускается bun-процессом в каталоге копии
// отслеживаемых файлов (cwd), печатает на stdout одну строку JSON MarkdownlintReport. `fix: false`
// закрывает и `"fix": true` конфига репозитория (иначе файлы были бы переписаны, а код был бы 0).
// Опция отключения импорта модулей не ставится: с ней строковые customRules молча выпадают, то есть
// «чисто»; без неё правило-пакет, которого нет в копии, — исключение main, то есть недоступность.
// Исключение main: его сообщение в stderr, код процесса 2, stdout пуст.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type LintResult, main } from 'markdownlint-cli2';

import type { MarkdownlintReport, MarkdownlintResult } from './guardrails-markdownlint.ts';

const collected: MarkdownlintResult[] = [];
let formatted = false;

function collect(options: { results: LintResult[] }): void {
	formatted = true;
	for (const r of options.results) {
		collected.push({
			fileName: r.fileName,
			lineNumber: r.lineNumber,
			ruleNames: r.ruleNames,
			ruleDescription: r.ruleDescription,
			errorDetail: r.errorDetail,
			severity: r.severity,
		});
	}
}

function packageVersion(): string {
	const dir = dirname(fileURLToPath(import.meta.resolve('markdownlint-cli2')));
	const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		!('version' in manifest) ||
		typeof manifest.version !== 'string'
	) {
		throw new Error('markdownlint-cli2 package.json has no version');
	}
	return manifest.version;
}

try {
	const code = await main({
		directory: process.cwd(),
		argv: [],
		logMessage: () => {},
		logError: (message: string) => {
			process.stderr.write(`${message}\n`);
		},
		optionsOverride: { fix: false, outputFormatters: [[collect]] },
	});
	const report: MarkdownlintReport = {
		version: packageVersion(),
		code,
		formatted,
		results: collected,
	};
	process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
