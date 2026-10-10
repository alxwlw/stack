// Фикстура: конфиг инструмента. ОЖИДАНИЕ (base,
// --type-aware): 0 находок no-floating-promises.
async function load(): Promise<number> {
	return 1;
}

export function boot(): void {
	load();
}
