"use strict";

const importsRule = require("./imports.cjs");
const exportsRule = require("./exports.cjs");

module.exports = {
  meta: {
    name: "eslint-plugin-simple-import-sort",
    version: "14.0.0",
  },
  rules: {
    imports: importsRule,
    exports: exportsRule,
  },
};
