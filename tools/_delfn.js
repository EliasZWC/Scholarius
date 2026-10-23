const fs = require("fs");
const path = "app/src/main/assets/www/reader.js";
let lines = fs.readFileSync(path, "utf8").split("\n");

const deadFns = ["renderFlat","appendLabeledRun","makeContentEl","makeLabeledBlock","makeAuthorLinesEl","makePlainPara","makeBlockEl"];

function findFnRange(lines, name) {
  const sig = "function " + name + "(";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(sig) >= 0) { start = i; break; }
  }
  if (start < 0) return null;
  let depth = 0, started = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; if (started && depth === 0) { end = i; break; } }
    }
    if (end >= 0) break;
  }
  return end >= 0 ? [start, end] : null;
}

const ranges = [];
for (const fn of deadFns) {
  const r = findFnRange(lines, fn);
  if (!r) { console.log("NOT FOUND", fn); continue; }
  ranges.push(r);
}
ranges.sort((a,b)=>b[0]-a[0]); // 从后往前删，避免行号错位

let removed = 0;
for (const [s,e] of ranges) {
  // 顺带把紧邻的函数上方的块注释一起删掉
  let top = s;
  while (top > 0 && lines[top-1].trim().startsWith("*")) top--;
  if (top > 0 && lines[top-1].trim().startsWith("/**")) top--;
  lines.splice(top, e - top + 1);
  removed += (e - top + 1);
}
fs.writeFileSync(path, lines.join("\n"), "utf8");
console.log("removed lines:", removed);
