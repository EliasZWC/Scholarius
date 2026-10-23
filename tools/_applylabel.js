const fs = require("fs");
const lines = fs.readFileSync("app/src/main/assets/www/reader.js","utf8").split("\n");
// 找 applyLabel 函数体末尾的 renderBlocks 调用
let inFn = false, depth = 0, startLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf("function applyLabel(") >= 0) { inFn = true; startLine = i; }
  if (!inFn) continue;
  for (const ch of lines[i]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
  if (lines[i].indexOf("renderBlocks") >= 0 || lines[i].indexOf("pushMdToNative") >= 0) {
    console.log((i+1) + ": " + lines[i].trim());
  }
  if (depth === 0 && i > startLine) { console.log("--- end at " + (i+1)); break; }
}
