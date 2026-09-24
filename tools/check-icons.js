/*
  图标一致性检查。

  起因：`design/venue-icons.html` 原先手抄了一份图标路径副本，改了组件忘了改
  预览页，两边长期不一致；`school` 那条两边都错，还互相"印证"，谁都没发现。

  现在预览页改为**直接加载 components.js**，副本问题从根上消失了。
  但仍有两处必须靠脚本盯住 —— 它们无法自动共享：

    · index.html 的**导航栏图标**是内联的（结构是 outline/fill 双份，
      与 icon() 的单份不同），改一处容易忘另一处。
    · design/venue-icons.html 里为了预览导航图标，用 `inline:` 抄了一条。

  本脚本校验：三处（index.html、venue-icons.html、components.js）里
  同一图标的路径必须逐字一致；且所有 venue* 图标都在 ICON_VIEWBOX 里登记。
*/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const idxHtml = read('app/src/main/assets/www/index.html');
const preview = read('design/venue-icons.html');
const components = read('app/src/main/assets/www/components.js');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const ok = (msg) => console.log('  ok    ' + msg);

console.log('\n[1] components.js — venue* 图标都登记了 viewBox');

const pathsBlock = /var ICON_PATHS = \{([\s\S]*?)\n    \};/.exec(components);
const viewboxBlock = /var ICON_VIEWBOX = \{([\s\S]*?)\n    \};/.exec(components);
if (!pathsBlock || !viewboxBlock) {
    fail('解析不到 ICON_PATHS 或 ICON_VIEWBOX');
} else {
    const names = [...pathsBlock[1].matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
    const venueNames = names.filter((n) => n.startsWith('venue'));
    const registered = [...viewboxBlock[1].matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);

    const missing = venueNames.filter((n) => !registered.includes(n));
    if (missing.length) fail('缺 viewBox: ' + missing.join(', '));
    else ok(venueNames.length + ' 个 venue 图标全部登记（' + venueNames.join(', ') + '）');

    const extra = registered.filter((n) => !names.includes(n));
    if (extra.length) fail('ICON_VIEWBOX 里有 ICON_PATHS 中不存在的键: ' + extra.join(', '));
    else ok('ICON_VIEWBOX 无多余键');
}

console.log('\n[2] index.html 导航栏 Vault = storage');

const tab = idxHtml.slice(idxHtml.indexOf('id="tab-vault"'), idxHtml.indexOf('id="tab-explore"'));
const tabPaths = [...tab.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
if (tabPaths.length !== 2) {
    fail('Vault tab 下的 <path> 应为 2 条（outline + fill），实为 ' + tabPaths.length);
} else if (tabPaths[0] !== tabPaths[1]) {
    fail('outline 与 fill 路径不同 —— storage 没有独立的填充变体，两者应逐字相同');
} else {
    ok('outline / fill 两条路径逐字相同');
}
if (tab.includes('viewBox="0 -960 960 960"')) {
    const n = (tab.match(/viewBox="0 -960 960 960"/g) || []).length;
    ok(n + ' 个 svg 使用 960 体系 viewBox');
} else {
    fail('Vault tab 的 viewBox 不是 "0 -960 960 960"（960 路径配 24 viewBox 会完全不渲染）');
}

console.log('\n[3] 预览页 inline 路径与 index.html 逐字一致');

const inline = /inline: '([^']+)'/.exec(preview);
if (!inline) {
    fail('预览页里找不到 inline 路径');
} else if (!tabPaths.length) {
    fail('无法比对（index.html 侧未取到路径）');
} else if (inline[1] !== tabPaths[0]) {
    fail('预览页 inline 与 index.html 不一致');
    console.log('        index.html : ' + tabPaths[0].slice(0, 60) + '…');
    console.log('        预览页     : ' + inline[1].slice(0, 60) + '…');
} else {
    ok('逐字一致');
}

console.log('\n[4] 预览页不再维护路径副本');

if (/var ICON = \{/.test(preview)) {
    fail('预览页仍有手抄的 ICON 表 —— 应改为加载 components.js');
} else if (!preview.includes('components.js')) {
    fail('预览页没有加载 components.js');
} else {
    ok('预览页直接从 components.js 取路径');
}

console.log('\n[5] 内联 / 组件脚本语法（含注释闭合）');

/*
  ⚠️ 为什么专门查这个：
     改注释时不小心把 `/*` 粘到了 `//` 行尾，于是块注释没开、
     后面的 `*​/` 成了孤立 token，**整个脚本静默失效** ——
     页面标题和静态 HTML 都正常，只有 JS 生成的部分全空。
     浏览器控制台只报 "Invalid or unexpected token"，不给行号，
     极难定位。用 new Function 编译一次就能立刻抓到。
*/
function checkScript(label, code) {
    try {
        new Function(code);
        ok(label + ' 语法正确');
        return true;
    } catch (e) {
        fail(label + ' 语法错误: ' + e.message);
        return false;
    }
}

checkScript('components.js', components);

const inlineScripts = [...preview.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
inlineScripts.forEach((m, i) => {
    checkScript('venue-icons.html 内联脚本 #' + (i + 1), m[1]);
});

console.log('\n' + (failures ? failures + ' 项未通过\n' : '全部通过\n'));
process.exit(failures ? 1 : 0);
