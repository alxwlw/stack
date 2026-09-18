/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		// ── Boundary rules (error) ──────────────────────────────────────

		{
			name: 'no-app-to-app',
			severity: 'error',
			comment:
				'Apps must not import from other apps — use shared packages instead. ' +
				'Exception: __e2e__ tests may import from any app.',
			from: { path: '^apps/([^/]+)/', pathNot: '^apps/__e2e__/' },
			to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
		},
		{
			name: 'no-package-to-app',
			severity: 'error',
			comment: 'Packages must not import from apps — dependency direction is apps → packages.',
			from: { path: '^packages/' },
			to: { path: '^apps/' },
		},
		{
			name: 'no-circular',
			severity: 'error',
			comment:
				'Circular dependencies make code hard to reason about and break tree-shaking. ' +
				'Exceptions: type-only cycles, NestJS forwardRef module cycles, dist/ artifacts ' +
				'(chunk-splitting bundlers can produce benign cross-chunk cycles in built output).',
			from: {
				pathNot: ['[.]module[.](?:ts|js)$', '^apps/[^/]+/dist/', '^packages/[^/]+/dist/'],
			},
			to: {
				circular: true,
				dependencyTypesNot: ['type-only'],
			},
		},

		// ── Hygiene rules (from default config) ─────────────────────────

		{
			name: 'no-orphans',
			severity: 'warn',
			comment:
				'This is an orphan module — it is likely not used anymore. Either use it or remove it.',
			from: {
				orphan: true,
				pathNot: [
					'(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$',
					'[.]d[.]ts$',
					'(^|/)tsconfig[.]json$',
					'(^|/)(?:babel|webpack)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$',
				],
			},
			to: {},
		},
		{
			name: 'no-deprecated-core',
			severity: 'warn',
			comment: 'A module depends on a deprecated Node core module.',
			from: {},
			to: {
				dependencyTypes: ['core'],
				path: [
					'^async_hooks$',
					'^punycode$',
					'^domain$',
					'^constants$',
					'^sys$',
					'^_linklist$',
					'^_stream_wrap$',
				],
			},
		},
		{
			name: 'not-to-deprecated',
			severity: 'warn',
			comment: 'This module uses a deprecated npm package.',
			from: {},
			to: { dependencyTypes: ['deprecated'] },
		},
		{
			name: 'no-non-package-json',
			severity: 'error',
			comment:
				"This module depends on an npm package that isn't in the 'dependencies' " +
				'section of your package.json.',
			from: {},
			to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
		},
		{
			name: 'not-to-unresolvable',
			severity: 'error',
			comment: 'This module depends on a module that cannot be resolved to disk.',
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: 'no-duplicate-dep-types',
			severity: 'warn',
			comment:
				'This module depends on an npm package that occurs in both dependencies and devDependencies.',
			from: {},
			to: {
				moreThanOneDependencyType: true,
				dependencyTypesNot: ['type-only'],
			},
		},
		{
			name: 'not-to-spec',
			severity: 'error',
			comment: 'Production code must not import from test files.',
			from: {},
			to: { path: '[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$' },
		},
		{
			name: 'not-to-dev-dep',
			severity: 'error',
			comment: 'This production module depends on a devDependency npm package.',
			from: {
				path: '^(packages|apps)',
				pathNot: '[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$',
			},
			to: {
				dependencyTypes: ['npm-dev'],
				dependencyTypesNot: ['type-only'],
				pathNot: ['node_modules/@types/'],
			},
		},
		{
			name: 'optional-deps-used',
			severity: 'info',
			comment: 'This module depends on an optional dependency.',
			from: {},
			to: { dependencyTypes: ['npm-optional'] },
		},
		{
			name: 'peer-deps-used',
			severity: 'warn',
			comment: 'This module depends on a peer dependency.',
			from: {},
			to: { dependencyTypes: ['npm-peer'] },
		},
	],
	options: {
		doNotFollow: { path: ['node_modules', '(^|/)dist(/|$)'] },
		exclude: { path: '(^|/)dist(/|$)' },
		includeOnly: ['^apps/', '^packages/'],
		tsPreCompilationDeps: true,
		detectJSDocImports: true,
		tsConfig: { fileName: 'tsconfig.json' },
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['import', 'require', 'node', 'default', 'types'],
			mainFields: ['main', 'types', 'typings'],
		},
		reporterOptions: {
			dot: {
				collapsePattern: '^(?:packages|apps)/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
				theme: {
					graph: { splines: 'ortho', rankdir: 'TB' },
					modules: [
						{
							criteria: { source: '^apps/' },
							attributes: { fillcolor: '#ccddff' },
						},
						{
							criteria: { source: '^packages/' },
							attributes: { fillcolor: '#ffffcc' },
						},
					],
				},
			},
			archi: {
				collapsePattern: '^(?:packages|apps)/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
			},
			text: { highlightFocused: true },
		},
	},
};
