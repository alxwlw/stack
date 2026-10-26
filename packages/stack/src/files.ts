import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import type { Repo } from './repo.ts';

// Один проход и один предикат дрейфа для check и sync: check печатает план, sync его применяет,
// поэтому «после sync — check зелёный» для файлов выполняется по построению.
export function planFiles(repo: Repo, canon: Canon): Drift[] {
	const plan: Drift[] = [];
	for (const f of canon.files) {
		// create-if-absent принадлежит репозиторию после первого засева: расхождением считается
		// только отсутствие (как у existsSync: каталог и нечитаемый файл на месте — не отсутствие),
		// содержимое не трогаем. Засев с альтернативами: репо уже держит тот же конфиг под другим
		// законным именем.
		if (
			f.strategy === 'create-if-absent' &&
			[f.dest, ...(f.satisfiedBy ?? [])].some((p) => repo.paths.has(p))
		) {
			continue;
		}
		const current = repo.files.get(f.dest);
		const exists = current !== undefined;
		if (current === f.content) continue;
		plan.push({
			code: exists ? 'file-drift' : 'file-missing',
			target: f.dest,
			message: exists ? `${f.dest} differs from canon` : `canon file missing: ${f.dest}`,
			file: f.dest,
			fix: `${f.strategy === 'create-if-absent' ? 'seeded' : 'updated'} ${f.dest}`,
			change: { kind: 'write', file: f.dest, content: f.content },
		});
	}
	return plan;
}
