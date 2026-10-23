const fs = require("fs");
const s = fs.readFileSync("app/src/main/assets/www/reader.js","utf8");
for (const n of ["authorRunEl","authorRunParts","authorRunLines","flushAuthorRun"]) {
  console.log(n.padEnd(18), s.split(n).length - 1);
}
