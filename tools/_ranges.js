const fs = require("fs");
const lines = fs.readFileSync("app/src/main/assets/www/reader.js","utf8").split("\n");
const targets = ["function renderFlat(","function appendLabeledRun(","function makeContentEl(","function makeLabeledBlock(","function makeAuthorLinesEl(","function makePlainPara(","function makeBlockEl(","function mdClassOf(","function roleClassOf(","function copyBlockAttrs(","function attachBodyMarker(","function labelSignatureOf(","function labelSplitsPerBlock(","function isAuthorLineSet(","function roleSignatureOf("];
lines.forEach((l,i)=>{ for(const t of targets) if(l.indexOf(t)>=0) console.log((i+1)+"\t"+l.trim().slice(0,70)); });
