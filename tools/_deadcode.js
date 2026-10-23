const fs = require("fs");
const s = fs.readFileSync("app/src/main/assets/www/reader.js", "utf8");
const names = ["renderFlat","appendLabeledRun","makeContentEl","makeLabeledBlock","makeAuthorLinesEl","makePlainPara","makeBlockEl","mdClassOf","roleClassOf"];
for (const n of names) {
  const count = (s.split(n).length - 1);
  console.log(n.padEnd(20), count);
}
