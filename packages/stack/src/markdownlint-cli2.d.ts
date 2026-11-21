// markdownlint-cli2 не поставляет типов: объявлена только та часть API, которую зовёт раннер группы
// guardrails (markdownlint-run.ts); поля параметров — из JSDoc пакета.
declare module 'markdownlint-cli2' {
	export interface LintResult {
		fileName: string;
		lineNumber: number;
		ruleNames: string[];
		ruleDescription: string;
		errorDetail: string | null;
		severity: string;
	}

	export function main(params: {
		directory: string;
		argv: string[];
		logMessage?: (message: string) => void;
		logError?: (message: string) => void;
		optionsOverride?: {
			fix?: boolean;
			outputFormatters?: [(options: { results: LintResult[] }) => void][];
		};
	}): Promise<number>;
}
