const fs = require("fs");
const s = fs.readFileSync("e:/product/Scholarius/app/src/main/java/com/eliaszwc/scholarius/MdDoc.kt", "utf8");
// 简单校验：正则和映射表都在
console.log("AUTHOR_FIELD_PREFIX:", /AUTHOR_FIELD_PREFIX/.test(s));
console.log("AUTHOR_FIELD_BY_LABEL:", /AUTHOR_FIELD_BY_LABEL/.test(s));
console.log("fieldHit:", /fieldHit/.test(s));
