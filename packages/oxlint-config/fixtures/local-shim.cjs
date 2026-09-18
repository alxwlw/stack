// EXPECTED with base preset: NO no-require-imports diagnostic — require() is
// legitimate in .cjs (repo-local config shims).
const base = require('./nonexistent-base.json');

module.exports = { ...base };
