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
 * Configuration is the nearest `tsdoc.json` (`TSDocConfigFile.loadForFolder`,
 * searched upward to the folder holding `package.json`, as eslint-plugin-tsdoc
 * does); without one the TSDoc defaults apply. The rule is switched on by the
 * `library.jsonc` overlay, not by `base`.
 */
import { dirname } from 'node:path';

import { TSDocConfiguration, TSDocParser } from '@microsoft/tsdoc';
import { TSDocConfigFile } from '@microsoft/tsdoc-config';

/** @type {Map<string, { parser: TSDocParser, configError?: string }>} */
const byFolder = new Map();

/** @param {string} folder */
function parserFor(folder) {
	let entry = byFolder.get(folder);
	if (entry) return entry;
	const configuration = new TSDocConfiguration();
	const configFile = TSDocConfigFile.loadForFolder(folder);
	let configError;
	if (configFile.fileNotFound) {
		// No tsdoc.json — TSDoc defaults.
	} else if (configFile.hasErrors) {
		configError = `${configFile.filePath}: ${configFile.getErrorSummary()}`;
	} else {
		configFile.configureParser(configuration);
	}
	entry = { parser: new TSDocParser(configuration), configError };
	byFolder.set(folder, entry);
	return entry;
}

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
				const filename = context.filename ?? context.getFilename();
				const { parser, configError } = parserFor(dirname(filename));
				if (configError) {
					context.report({
						loc: { line: 1, column: 0 },
						messageId: 'tsdocMessage',
						data: { id: 'tsdoc-config-error', text: configError },
					});
				}
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
