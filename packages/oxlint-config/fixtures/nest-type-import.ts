// Фикстура: класс импортирован значением и встречается только как тип параметра конструктора.
// Для Nest DI это обязательная форма (метаданные типа берутся из значения). ОЖИДАНИЕ: под nest —
// 0 находок consistent-type-imports; под node — ровно одна.
import { Injectable } from './nest-decorators.js';
import { Repo } from './nest-repo.js';

@Injectable()
export class UsesRepo {
	constructor(private readonly repo: Repo) {}

	read(): number {
		return this.repo.find();
	}
}
