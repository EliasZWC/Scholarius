global.window = global;
const fs = require("fs");
require("e:/product/Scholarius/app/src/main/assets/www/md.js");
require("e:/product/Scholarius/app/src/main/assets/www/i18n.js");
const md = global.ScholariusMarkdown;
const i18n = global.ScholariusI18n;

const lib = fs.readFileSync("e:/product/Scholarius/app/src/main/assets/www/dev-library.js", "utf8");
const m = lib.match(/window\.ScholariusDevLibrary\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
const L = new Function("window", "return " + m[1])({});
const d = L.docs.find(x => x.id === "dev2");

const blocks = (d._blocks || []).map(b => ({
    kind: b.kind || "paragraph",
    level: b.level,
    text: b.text || "",
    lines: b.lines
}));

const out = md.toMarkdown(blocks, {
    listKinds: { author: true, reference: true },
    fieldLabel: f => i18n.t("reader.field." + f)
});
fs.writeFileSync("e:/product/Scholarius/tools/devtest1_doc.md", out, "utf8");
console.log("bytes:", Buffer.byteLength(out, "utf8"));
