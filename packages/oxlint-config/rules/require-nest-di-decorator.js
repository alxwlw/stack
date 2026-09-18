// @ts-check

/**
 * ESLint rule: require-nest-di-decorator
 *
 * In a NestJS DI-managed class (`@Injectable`, `@Controller`, `@Catch`),
 * every constructor parameter that carries a default value must also carry
 * an `@Optional()` decorator. Without it, Nest treats the parameter as a
 * required dependency, fails to resolve a provider for it, and throws
 * `UnknownDependenciesException` at runtime — even though `tsc` and local
 * dev pass cleanly. SWC (the prod Docker compiler) strips
 * `emitDecoratorMetadata`, so the only signal Nest has that the parameter
 * is optional is the explicit `@Optional()` decorator.
 *
 * @example
 * Triggers an error:
 * ```ts
 * @Injectable()
 * class Foo {
 *   constructor(
 *     @Inject(CONFIG) cfg: Cfg,
 *     private readonly inner: GetFn = defaultFn, // ← missing @Optional()
 *   ) {}
 * }
 * ```
 *
 * Allowed:
 * ```ts
 * @Injectable()
 * class Foo {
 *   constructor(
 *     @Inject(CONFIG) cfg: Cfg,
 *     @Optional() private readonly inner: GetFn = defaultFn,
 *   ) {}
 * }
 * ```
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require @Optional() on Nest DI constructor parameters that have a default value',
		},
		schema: [],
		messages: {
			missingOptional:
				'Constructor parameter "{{name}}" of @{{classDecorator}}() class "{{className}}" has a default value but no @Optional() decorator. Add @Optional() — without it Nest treats the parameter as required, fails to resolve a provider, and throws UnknownDependenciesException at runtime under SWC builds (prod Docker), even though tsc/local dev pass.',
			missingOptionalAnonymous:
				'Constructor parameter of @{{classDecorator}}() class "{{className}}" has a default value but no @Optional() decorator. Add @Optional() — required for Nest to apply the default under SWC builds.',
		},
	},
	create(context) {
		const NEST_DI_DECORATORS = new Set(['Injectable', 'Controller', 'Catch']);

		function decoratorName(decorator) {
			const expr = decorator.expression;
			if (expr.type === 'Identifier') return expr.name;
			if (expr.type === 'CallExpression') {
				const callee = expr.callee;
				if (callee.type === 'Identifier') return callee.name;
				if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier') {
					return callee.object.name;
				}
			}
			return null;
		}

		function findClassDecorator(node) {
			const decorators = node.decorators ?? [];
			for (const d of decorators) {
				const name = decoratorName(d);
				if (name && NEST_DI_DECORATORS.has(name)) return name;
			}
			return null;
		}

		/**
		 * A param has a default iff it (or its inner TSParameterProperty
		 * payload) is an `AssignmentPattern`.
		 */
		function hasDefault(param) {
			if (param.type === 'AssignmentPattern') return true;
			if (param.type === 'TSParameterProperty') return hasDefault(param.parameter);
			return false;
		}

		function paramDecorators(param) {
			if (param.type === 'TSParameterProperty') {
				return [...(param.decorators ?? []), ...(param.parameter.decorators ?? [])];
			}
			return param.decorators ?? [];
		}

		function paramName(param) {
			if (param.type === 'Identifier') return param.name;
			if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
				return param.left.name;
			}
			if (param.type === 'TSParameterProperty') return paramName(param.parameter);
			return null;
		}

		return {
			ClassDeclaration(node) {
				const classDecorator = findClassDecorator(node);
				if (!classDecorator) return;

				const className = node.id ? node.id.name : '<anonymous>';
				const ctor = node.body.body.find(
					(m) => m.type === 'MethodDefinition' && m.kind === 'constructor',
				);
				if (!ctor) return;

				for (const param of ctor.value.params) {
					if (!hasDefault(param)) continue;

					const decorators = paramDecorators(param);
					const hasOptional = decorators.some((d) => decoratorName(d) === 'Optional');
					if (hasOptional) continue;

					const name = paramName(param);
					context.report({
						node: param,
						messageId: name ? 'missingOptional' : 'missingOptionalAnonymous',
						data: { name: name ?? '', className, classDecorator },
					});
				}
			},
		};
	},
};

export default {
	rules: {
		'require-nest-di-decorator': rule,
	},
};
