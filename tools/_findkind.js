const fs = require("fs");
const p = "app/src/main/assets/www/reader.js";
const lines = fs.readFileSync(p, "utf8").split("\n");
// 找 renderMd 里的 b.kind 使用
let inFn = false, depth = 0, start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf("function renderMd(") >= 0) { inFn = true; start = i; }
  if (!inFn) continue;
  for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
  if (lines[i].indexOf("b.kind") >= 0) console.log((i+1) + ": " + lines[i].trim());
  if (depth === 0 && i > start && start > 0) break;
}
