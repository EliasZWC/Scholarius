global.window = global;
require("e:/product/Scholarius/app/src/main/assets/www/md.js");
const md = global.ScholariusMarkdown;
console.log("first_lv1 :", JSON.stringify(md.headingPrefix("heading", 1, true)));
console.log("nonfirst  :", JSON.stringify(md.headingPrefix("heading", 1, false)));
console.log("title_lv0 :", JSON.stringify(md.headingPrefix("heading", 0, true)));
