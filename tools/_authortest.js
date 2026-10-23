global.window = global;
require("e:/product/Scholarius/app/src/main/assets/www/md.js");
const md = global.ScholariusMarkdown;

// 场景 A：未划分子标签
const blocksA = [
  { kind: "heading", level: 0, text: "Attention Is All You Need" },
  { kind: "author", text: "Ashish Vaswani", authorItems: [{ text: "Ashish Vaswani", field: null }] },
  { kind: "author", text: "Google Brain", authorItems: [{ text: "Google Brain", field: null }] }
];
console.log("=== A: no sub-labels ===");
console.log(md.toMarkdown(blocksA, { listKinds: { author: true }, fieldLabel: f => f }));

// 场景 B：标了子标签
const blocksB = [
  { kind: "heading", level: 0, text: "Attention Is All You Need" },
  { kind: "author", text: "Ashish Vaswani", authorItems: [{ text: "Ashish Vaswani", field: "name" }] },
  { kind: "author", text: "Google Brain", authorItems: [{ text: "Google Brain", field: "affiliation" }] }
];
console.log("=== B: with sub-labels ===");
console.log(md.toMarkdown(blocksB, { listKinds: { author: true }, fieldLabel: f => "Author " + f }));
