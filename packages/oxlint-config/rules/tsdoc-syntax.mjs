// @ts-check

/**
 * oxlint JS-plugin rule: tsdoc-syntax
 *
 * Replacement for `eslint-plugin-tsdoc`'s `tsdoc/syntax`: validates every
 * `/** … * /` doc comment with the official `@microsoft/tsdoc` parser (the
 * same engine eslint-plugin-tsdoc wraps). Written in-house because
 * eslint-plugin-tsdoc ≥0.5 transitively requires the `eslint` package at load
 * time — which this repo removed when migrating to oxlint.
 *
 * No `tsdoc.json` support: the repo never had one, so the default TSDoc
 * configuration is used (matches the previous behaviour).
 */
import { TSDocParser } from '@microsoft/tsdoc';

const parser = new TSDocParser();

export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Validates that TypeScript doc comments conform to the TSDoc standard',
		},
		schema: [],
		messages: {
			tsdocMessage: '{{id}}: {{text}}',
		},
	},
	create(context) {
		return {
			Program() {
				const sourceCode = context.sourceCode ?? context.getSourceCode();
				for (const comment of sourceCode.getAllComments()) {
					// Only `/** … */` doc comments — same trigger as eslint-plugin-tsdoc.
					if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;

					const commentStart = comment.range[0];
					const text = `/*${comment.value}*/`;
					const parserContext = parser.parseString(text);

					for (const message of parserContext.log.messages) {
						let loc;
						if (typeof sourceCode.getLocFromIndex === 'function') {
							const start = commentStart + message.textRange.pos;
							const end = Math.max(commentStart + message.textRange.end, start + 1);
							loc = {
								start: sourceCode.getLocFromIndex(start),
								end: sourceCode.getLocFromIndex(end),
							};
						} else {
							loc = comment.loc;
						}
						context.report({
							loc,
							messageId: 'tsdocMessage',
							data: { id: message.messageId, text: message.unformattedText },
						});
					}
				}
			},
		};
	},
};
