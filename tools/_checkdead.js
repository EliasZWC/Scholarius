const fs = require("fs");
const s = fs.readFileSync("app/src/main/assets/www/reader.js", "utf8");
const lines = s.split("\n");
const dead = ["renderFlat","appendLabeledRun","makeContentEl","makeLabeledBlock","makeAuthorLinesEl","makePlainPara","makeBlockEl","mdClassOf","roleClassOf"];
let hits = 0;
lines.forEach((l,i)=>{
  for (const d of dead) {
    if (l.indexOf(d) >= 0 && !l.trim().startsWith("*") && !l.trim().startsWith("//")) {
      console.log((i+1)+": "+l.trim().slice(0,100)); hits++; break;
    }
  }
});
console.log("--- non-comment hits:", hits);
