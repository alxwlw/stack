import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { canonFile, repoDir, runTool, toolJson } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

// Путь к бинарю из пина: последняя непустая строка stdout. В окружении агента proto печатает NDJSON,
// и путь лежит в поле message последней строки. Нет бинаря — тест падает с выводом proto, а не пропускается.
function protoBin(tool: string): string {
	const r = spawnSync('proto', ['bin', tool], { cwd: ROOT, encoding: 'utf8' });
	if (r.error) throw new Error(`proto bin ${tool}: ${r.error.message}`);
	let last = r.stdout
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '')
		.at(-1);
	if (last?.startsWith('{')) {
		try {
			const message: unknown = (JSON.parse(last) as { message?: unknown }).message;
			if (typeof message === 'string') last = message;
		} catch {
			// не JSON: остаётся как есть, existsSync ниже отклонит
		}
	}
	if (r.status !== 0 || !last || !existsSync(last)) {
		throw new Error(
			`proto bin ${tool}: нет бинаря (status=${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
		);
	}
	return last;
}

// 64 hex собираются во время выполнения, поэтому eth-правило канона не видит их в исходнике; в имени
// нет слов key, secret, token, которые ищет generic-api-key из правил по умолчанию.
const HEX = '0123456789abcdef'.repeat(4);
// Hardhat/Anvil #0 — публичный, стоит в allowlist канона.
const HARDHAT_0 = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Цепочка потребителя: gitleaks ищет конфиг засева в каталоге сканирования, а путь `[extend]`
// разрешает от cwd. Поэтому cwd — каталог фикстуры, и запуск идёт без `--config`, как в check.yml
// потребителя. Код 1 ставится и на находку, и на сломанный конфиг, поэтому решает разобранный JSON.
test('канон gitleaks: ETH_PRIV ловится, в планах superpowers и с ключом Hardhat — нет', () => {
	const dir = repoDir({
		'.gitleaks.toml': canonFile('.gitleaks.toml'),
		'.gitleaks.canon.toml': canonFile('.gitleaks.canon.toml'),
		'src/a.ts': `ETH_PRIV=0x${HEX}\n`,
		'docs/superpowers/plans/p.md': `ETH_PRIV=0x${HEX}\n`,
		'src/h.ts': `ETH_PRIV=0x${HARDHAT_0}\n`,
	});
	try {
		const run = runTool(
			protoBin('gitleaks'),
			['dir', '.', '--no-banner', '--report-format', 'json', '--report-path', '-'],
			dir,
		);
		expect(run.status, run.ctx).toBe(1);
		const found = toolJson<{ RuleID: string; File: string }[]>(run)
			.map((f) => `${f.RuleID} ${f.File}`)
			.sort();
		expect(found).toStrictEqual(['eth-private-key-no-prefix src/a.ts']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
