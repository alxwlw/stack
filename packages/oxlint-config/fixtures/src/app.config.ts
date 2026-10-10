// Фикстура: продовый модуль с суффиксом .config.ts внутри src/ — это код приложения, не конфиг
// инструмента. ОЖИДАНИЕ (base, --type-aware): ровно одна no-floating-promises.
async function load(): Promise<number> {
	return 1;
}

export function boot(): void {
	load();
}
