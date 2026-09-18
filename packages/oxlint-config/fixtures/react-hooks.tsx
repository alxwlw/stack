// Fixture for the react preset. EXPECTED: exactly one diagnostic —
// react-hooks rules-of-hooks (conditional hook call).
import { useState } from 'react';

export function Broken({ flag }: { flag: boolean }): number {
	if (flag) {
		const [n] = useState(0);
		return n;
	}
	return 0;
}
