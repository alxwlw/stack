import { type Canon, parsePins } from './canon.ts';
import type { Exception } from './exceptions.ts';
import type { Drift } from './findings.ts';
import type { Repo } from './repo.ts';
import { pinSiteKind, rewritePinCopies } from './toolchain-pins.ts';

// Пины, с которыми сверяются копии. Исключение на .prototools — репозиторий держит свой тулчейн:
// берутся строки его собственного файла (нет файла или он не разбирается — пинов нет). Иначе — пины
// канона: это пины файла, который будет у репозитория после sync, один sync двигает и их, и копии.
function pinsFor(
	repo: Repo,
	canon: Canon,
	exceptions: readonly Exception[],
): Record<string, string> {
	if (!exceptions.some((e) => e.file === '.prototools')) return canon.pins;
	const own = repo.files.get('.prototools');
	if (own === undefined) return {};
	try {
		return parsePins(own);
	} catch {
		return {};
	}
}

// Копии пинов тулчейна в Dockerfile и workflow: одна находка на файл, правка — весь файл целиком.
// Файлы, которыми владеет канон, правило не смотрит — все dest, и verbatim (их текст целиком задаёт
// planFiles или удерживает исключение), и засеваемые (create-if-absent): второй write в тот же файл затёр
// бы первый. Среди dest сегодня нет файлов с копиями пинов — это закрепляет тест «в канон-файлах копий пинов нет».
export function planToolchainPins(
	repo: Repo,
	canon: Canon,
	exceptions: readonly Exception[],
): Drift[] {
	const pins = pinsFor(repo, canon, exceptions);
	const owned = new Set(canon.files.map((f) => f.dest));
	const drifts: Drift[] = [];
	for (const path of [...repo.files.keys()].sort()) {
		const kind = pinSiteKind(path);
		if (kind === undefined || owned.has(path)) continue;
		const text = repo.files.get(path) as string;
		const { text: content, changes } = rewritePinCopies(kind, text, pins);
		if (changes.length === 0) continue;
		const moves = new Set(changes.map((c) => `${c.tool} ${c.from} → ${c.to}`));
		drifts.push({
			code: 'toolchain-pin',
			target: path,
			file: path,
			message: `${changes
				.map((c) => `${c.tool} ${c.from} instead of ${c.to} (line ${c.line})`)
				.join(', ')}: pin copies follow .prototools`,
			fix: `${path}: ${[...moves].join(', ')}`,
			change: { kind: 'write', file: path, content },
		});
	}
	return drifts;
}
