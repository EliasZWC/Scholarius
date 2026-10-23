const fs = require("fs");
const path = "app/src/main/assets/www/reader.js";
const src = fs.readFileSync(path, "utf8");
const lines = src.split("\n");

// 要删除的函数（按函数名找起始，靠大括号配对找结束）
const deadFns = [
  "renderFlat", "appendLabeledRun", "makeContentEl",
  "makeLabeledBlock", "makeAuthorLinesEl", "makePlainPara",
  "makeBlockEl", "mdClassOf", "roleClassOf"
];

function findFnRange(lines, name) {
  const sig = "function " + name + "(";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(sig) >= 0 && (lines[i].trim().startsWith("function ") || lines[i].trim().startsWith("function " + name))) {
      start = i; break;
    }
  }
  if (start < 0) return null;
  // 从函数体第一个 { 开始配对
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
  if (r) { ranges.push([fn, r[0], r[1]]); }
  else { console.log("NOT FOUND:", fn); }
}
ranges.sort((a,b)=>a[1]-b[1]);
for (const [fn,s,e] of ranges) console.log(fn, (s+1)+"-"+(e+1), "lines="+(e-s+1));
