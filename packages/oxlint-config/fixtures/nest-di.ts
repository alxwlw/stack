// Fixture for stack/require-nest-di-decorator (nest preset). EXPECTED: exactly
// one diagnostic — BadService's `inner` param (default value, no @Optional).
import { Injectable, Optional } from './nest-decorators.js';

const DEFAULT_FN = (): number => 1;

@Injectable()
export class BadService {
	constructor(private readonly inner: () => number = DEFAULT_FN) {
		void this.inner;
	}
}

@Injectable()
export class GoodService {
	constructor(@Optional() private readonly inner: () => number = DEFAULT_FN) {
		void this.inner;
	}
}

// Not a Nest DI class — defaults without @Optional are fine here.
export class PlainClass {
	constructor(x: number = 1) {
		void x;
	}
}
