const fs = require("fs");
const s = fs.readFileSync("app/src/main/assets/www/reader.js", "utf8");
const lines = s.split("\n");
const targets = ["renderFlat","appendLabeledRun","makeContentEl","makeLabeledBlock","makeAuthorLinesEl","makePlainPara","makeBlockEl","mdClassOf","roleClassOf"];
lines.forEach((l, i) => {
  for (const t of targets) {
    const idx = l.indexOf(t);
    if (idx >= 0 && l.indexOf("function " + t) < 0) {
      console.log((i+1) + ": " + l.trim().slice(0, 110));
      break;
    }
  }
});
