global.window = global;
require("e:/product/Scholarius/app/src/main/assets/www/md.js");
require("e:/product/Scholarius/app/src/main/assets/www/i18n.js");
const md = global.ScholariusMarkdown;
const i18n = global.ScholariusI18n;
console.log("i18n name:", i18n.t("reader.field.name"));
console.log("i18n aff :", i18n.t("reader.field.affiliation"));

const blocks = [
  { kind: "heading", level: 0, text: "Attention Is All You Need" },
  { kind: "author", text: "Ashish Vaswani", authorItems: [{ text: "Ashish Vaswani", field: "name" }] },
  { kind: "author", text: "Google Brain", authorItems: [{ text: "Google Brain", field: "affiliation" }] }
];
console.log("---");
console.log(md.toMarkdown(blocks, { listKinds: { author: true }, fieldLabel: f => i18n.t("reader.field." + f) }));
