// @ts-check

/**
 * oxlint JS-plugin rule: naming-convention
 *
 * Port of `@typescript-eslint/naming-convention` restricted to the EXACT
 * selector set the canon eslint-config node preset configured
 * (typescript-eslint is incompatible with TypeScript 7 — no compiler API
 * until TS 7.1, which is why the oxlint canon carries its own port):
 *
 * 1. default            → camelCase
 * 2. variable           → camelCase | UPPER_CASE
 * 3. variable const+top → camelCase | UPPER_CASE | PascalCase
 * 4. parameter          → camelCase            (leadingUnderscore: allow)
 * 5. typeLike           → PascalCase
 * 6. enumMember         → UPPER_CASE | PascalCase
 * 7. property           → exempt (format: null)
 * 8. import             → exempt (format: null)
 *
 * Options: `{ "leadingUnderscore": "none" | "allow" | "allowSingleOrDouble" }`
 * applied to the default/variable selectors (canon default: "none"; repos with
 * a `_`-prefix private-by-convention marker — e.g. paired with a no-unused-vars
 * `^_` ignore — opt into "allowSingleOrDouble"). The parameter selector always
 * allows a single leading underscore, like the canon eslint preset.
 *
 * Type-based selectors were never configured in the canon, so no type
 * information is needed (JS-plugin rules have none).
 */
// Case-transform validators, NOT ASCII regexes — mirrors typescript-eslint's
// non-strict format checks: caseless characters (`$`, digits, Greek `φ`) pass
// both camelCase and PascalCase first-char checks, exactly like upstream
// (`$allOperations`, `φ1` are legal camelCase there).
const FORMATS = {
	camelCase: (name) => name[0] === name[0].toLowerCase() && !name.includes('_'),
	PascalCase: (name) => name[0] === name[0].toUpperCase() && !name.includes('_'),
	UPPER_CASE: (name) => name === name.toUpperCase(),
};

function trimLeadingUnderscores(name, mode) {
	if (mode === 'allowSingleOrDouble') {
		if (name.startsWith('__')) return name.slice(2);
		if (name.startsWith('_')) return name.slice(1);
		return name;
	}
	if (mode === 'allow') {
		return name.startsWith('_') ? name.slice(1) : name;
	}
	return name;
}

function matchesAny(name, formats, underscoreMode) {
	const trimmed = trimLeadingUnderscores(name, underscoreMode);
	// Bare `_`/`__` sentinels (unused-arg idiom) reduce to '' — always legal.
	if (trimmed.length === 0) return true;
	return formats.some((f) => FORMATS[f](trimmed));
}

/** Collect binding Identifier nodes out of a declaration/parameter pattern. */
function collectBindingIds(pattern, out) {
	if (!pattern) return out;
	switch (pattern.type) {
		case 'Identifier':
			out.push(pattern);
			break;
		case 'ObjectPattern':
			for (const prop of pattern.properties ?? []) {
				if (prop.type === 'RestElement') collectBindingIds(prop.argument, out);
				else collectBindingIds(prop.value, out); // key stays exempt (property)
			}
			break;
		case 'ArrayPattern':
			for (const el of pattern.elements ?? []) collectBindingIds(el, out);
			break;
		case 'AssignmentPattern':
			collectBindingIds(pattern.left, out);
			break;
		case 'RestElement':
			collectBindingIds(pattern.argument, out);
			break;
		default:
			break;
	}
	return out;
}

export default {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Enforce the canon naming conventions (port of the canon @typescript-eslint/naming-convention selector set)',
		},
		schema: [
			{
				type: 'object',
				properties: {
					leadingUnderscore: {
						enum: ['none', 'allow', 'allowSingleOrDouble'],
					},
				},
				additionalProperties: false,
			},
		],
		messages: {
			badName: "{{kind}} name '{{name}}' must match one of the following formats: {{formats}}",
		},
	},
	create(context) {
		const defaultUnderscore = context.options?.[0]?.leadingUnderscore ?? 'none';

		function report(idNode, kind, formats, underscoreMode) {
			const name = idNode.name;
			if (typeof name !== 'string') return;
			if (matchesAny(name, formats, underscoreMode)) return;
			context.report({
				node: idNode,
				messageId: 'badName',
				data: { kind, name, formats: formats.join(', ') },
			});
		}

		/** Module-top-level = declaration whose statement parent chain hits Program directly. */
		function isTopLevel(node) {
			let p = node.parent;
			// unwrap `export const …` / `export default …`
			if (p && (p.type === 'ExportNamedDeclaration' || p.type === 'ExportDefaultDeclaration')) {
				p = p.parent;
			}
			return p != null && p.type === 'Program';
		}

		function checkFunctionParams(node) {
			for (const param of node.params ?? []) {
				if (param.type === 'TSParameterProperty') {
					// parameterProperty falls under the default selector
					for (const id of collectBindingIds(param.parameter, [])) {
						if (id.name === 'this') continue;
						report(id, 'Parameter property', ['camelCase'], defaultUnderscore);
					}
					continue;
				}
				for (const id of collectBindingIds(param, [])) {
					if (id.name === 'this') continue;
					report(id, 'Parameter', ['camelCase'], 'allow');
				}
			}
		}

		return {
			VariableDeclaration(node) {
				const topLevelConst = node.kind === 'const' && isTopLevel(node);
				const formats = topLevelConst
					? ['camelCase', 'UPPER_CASE', 'PascalCase']
					: ['camelCase', 'UPPER_CASE'];
				for (const decl of node.declarations ?? []) {
					for (const id of collectBindingIds(decl.id, [])) {
						report(id, 'Variable', formats, defaultUnderscore);
					}
				}
			},
			FunctionDeclaration(node) {
				if (node.id) report(node.id, 'Function', ['camelCase'], defaultUnderscore);
				checkFunctionParams(node);
			},
			TSDeclareFunction(node) {
				if (node.id) report(node.id, 'Function', ['camelCase'], defaultUnderscore);
				checkFunctionParams(node);
			},
			FunctionExpression(node) {
				checkFunctionParams(node);
			},
			ArrowFunctionExpression(node) {
				checkFunctionParams(node);
			},
			MethodDefinition(node) {
				if (node.kind === 'constructor') return;
				if (node.computed || node.key.type !== 'Identifier') return;
				report(node.key, 'Method', ['camelCase'], defaultUnderscore);
			},
			Property(node) {
				// Only shorthand-METHOD keys are checked (objectLiteralMethod → default
				// selector); plain properties are exempt (property → format: null).
				if (!node.method || node.computed || node.key.type !== 'Identifier') return;
				report(node.key, 'Method', ['camelCase'], defaultUnderscore);
			},
			ClassDeclaration(node) {
				if (node.id) report(node.id, 'Class', ['PascalCase'], 'none');
			},
			ClassExpression(node) {
				if (node.id) report(node.id, 'Class', ['PascalCase'], 'none');
			},
			TSInterfaceDeclaration(node) {
				report(node.id, 'Interface', ['PascalCase'], 'none');
			},
			TSTypeAliasDeclaration(node) {
				report(node.id, 'Type alias', ['PascalCase'], 'none');
			},
			TSEnumDeclaration(node) {
				report(node.id, 'Enum', ['PascalCase'], 'none');
			},
			TSTypeParameter(node) {
				// Only declaration-position type params (`<T>` lists) — the original
				// selector was `TSTypeParameterDeclaration > TSTypeParameter`, which
				// never touched `infer X` (parent TSInferType).
				if (node.parent != null && node.parent.type !== 'TSTypeParameterDeclaration') return;
				const nameNode = typeof node.name === 'object' && node.name != null ? node.name : node;
				const name = typeof node.name === 'string' ? node.name : node.name?.name;
				if (typeof name !== 'string') return;
				if (matchesAny(name, ['PascalCase'], 'none')) return;
				context.report({
					node: nameNode,
					messageId: 'badName',
					data: { kind: 'Type parameter', name, formats: 'PascalCase' },
				});
			},
			TSEnumMember(node) {
				if (node.id.type !== 'Identifier') return; // string-literal keys exempt
				report(node.id, 'Enum member', ['UPPER_CASE', 'PascalCase'], 'none');
			},
		};
	},
};
