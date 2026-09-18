// Fixture for the react preset. oxlint >=1.75 enables `react/refs` and
// `react/set-state-in-effect` by default whenever the `react` plugin is on,
// even though neither is in react.jsonc's explicit rule list (a live
// acceptance run found 35 unreviewed findings from these two rules alone in
// one adopting org's existing frontend code). react.jsonc turns both off
// (dated, temporary) until the affected consumer has triaged its own
// findings — this fixture proves the off-switch, not the rule.
import { useEffect, useRef, useState } from 'react';

export function RefDuringRender(): number {
	const ref = useRef(0);
	return ref.current;
}

export function SetStateInEffect(): null {
	const [, setValue] = useState(0);
	useEffect(() => {
		setValue(1);
	}, []);
	return null;
}
