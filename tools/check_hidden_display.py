"""扫描 CSS/JS，找出「会用 hidden 切换、但样式里覆盖了 display」的元素。

⚠️ 为什么需要它（2026-09-24，同一个 bug 犯了两次）：

    `hidden` 属性只对应 UA 样式表的 `display: none`。
    **任何作者样式里的 display 都会覆盖它。**

    于是出现这种极隐蔽的现象：
        el.hidden === true          ← 读出来是"已隐藏"
        getComputedStyle(el).display === 'flex'   ← 实际还在显示

    两次实例：
      ① .reader-action { display: flex } → 底栏「目录/设置」没藏住，
         编辑模式下出现六个选项挤成两排（看截图才发现）。
      ② .reader-annotate-icon { display: flex } → 编辑按钮的两只图标
         上下摞成两行，按钮被撑高（用户一眼看出来）。

    这是个**看一眼代码不会发现**的错误：单独看 CSS 或单独看 JS 都正常，
    只有把"JS 会设 hidden"与"CSS 设了 display"对起来才暴露。
    所以用脚本对。

══ ⚠️⚠️ 顺带记一条**验证时的纪律**（我因此误判过一次）══

    判断"某个元素到底有没有显示"，**不能**用
    `getComputedStyle(el).display !== 'none'` ——
    当元素是被**父级**的 display:none 隐藏时（比如编辑选项栏整体 hidden），
    子元素自己的 computed display 仍然是它声明的值（`flex`），
    于是会误判成"还显示着"。

    可靠的判断是：
        el.offsetParent === null            ← 不在渲染树里
        el.getBoundingClientRect().width === 0

    实测教训：我用 `display !== 'none'` 过滤底栏按钮，
    得到"六个都可见"的错误结论 —— 而截图里只有两个。
    看截图反而比看这个属性可靠。

用法: python tools/check_hidden_display.py
"""
import io
import os
import re
import sys

CSS = os.path.join("app", "src", "main", "assets", "www", "styles.css")
JS_DIR = os.path.join("app", "src", "main", "assets", "www")

# JS 里"用 hidden 切换"的写法
JS_HIDDEN_PATTERNS = [
    # el.hidden = true / x.hidden = !cond
    re.compile(r"([A-Za-z_$][\w$.]*)\s*\.hidden\s*="),
    # setAttribute('hidden', ...)
    re.compile(r"([A-Za-z_$][\w$.]*)\.setAttribute\(\s*'hidden'"),
]


def strip_comments(css):
    """去掉 CSS 注释与字符串，避免把注释里的示例当成真规则。"""
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
    css = re.sub(r'"[^"]*"', '""', css)
    css = re.sub(r"'[^']*'", "''", css)
    return css


def find_display_rules(css):
    """返回 [(选择器, display值)]，只保留 display 非 none 的。"""
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        sel = m.group(1).strip()
        body = m.group(2)
        dm = re.search(r"(?<![\w-])display\s*:\s*([^;}]+)", body)
        if not dm:
            continue
        val = dm.group(1).strip()
        if val == "none":
            continue
        # 选择器里带 [hidden] 的本身就是修法，跳过
        if "[hidden]" in sel:
            continue
        out.append((sel, val))
    return out


def selector_classes(sel):
    """取出一个选择器里的所有类名（只取最后一个简单选择器的，粗略但够用）。"""
    # 去掉伪类/伪元素
    sel = re.sub(r"::?[\w-]+(\([^)]*\))?", "", sel)
    # 取最后一个组合子之后的部分（"A > B" 里 B 才是要匹配的元素）
    part = re.split(r"[ >+~]", sel)[-1] if sel else ""
    return set(re.findall(r"\.([A-Za-z_][\w-]*)", part))


def main():
    if not os.path.isfile(CSS):
        print("找不到 %s（要在项目根目录运行）" % CSS)
        return 1

    css_raw = io.open(CSS, encoding="utf-8").read()
    css = strip_comments(css_raw)
    rules = find_display_rules(css)

    # 收集 JS 里会被 .hidden 赋值的元素标识
    js_refs = set()
    for root, _dirs, files in os.walk(JS_DIR):
        for fn in files:
            if not fn.endswith(".js"):
                continue
            path = os.path.join(root, fn)
            src = io.open(path, encoding="utf-8").read()
            src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
            src = re.sub(r"//[^\n]*", "", src)
            for pat in JS_HIDDEN_PATTERNS:
                for m in pat.finditer(src):
                    js_refs.add(m.group(1).split(".")[-1])

    if not js_refs:
        print("JS 里没找到 .hidden 赋值（无检查对象）")
        return 0

    # 找出"类名出现在 JS hidden 赋值里、且 CSS 给了非 none 的 display"
    problems = []
    for sel, val in rules:
        cls = selector_classes(sel)
        if not cls:
            continue
        hit = cls & js_refs
        if hit:
            # 该选择器本身没有配 [hidden] 规则就要报
            has_hidden_rule = any(
                other_cls == cls and "[hidden]" in other_sel
                for other_sel, _v in find_display_rules_all(css)
                for other_cls in [selector_classes(other_sel)]
            )
            if not has_hidden_rule:
                problems.append(
                    "选择器 `%s` 设了 display: %s，而类名 %s 在 JS 里被 .hidden 赋值"
                    % (sel, val, "、".join(sorted(hit)))
                )

    if problems:
        print("⚠️ 以下元素用 hidden 切换，但样式覆盖了 display：")
        for p in problems:
            print("  " + p)
        print("\n修法：加一条 `.<选择器> [hidden] { display: none; }`")
        return 1

    print("OK: 没有发现 hidden / display 冲突")
    return 0


def find_display_rules_all(css):
    """与 find_display_rules 相同，但**保留** [hidden] 规则（用于查有没有配）。"""
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        sel = m.group(1).strip()
        dm = re.search(r"(?<![\w-])display\s*:\s*([^;}]+)", m.group(2))
        if dm:
            out.append((sel, dm.group(1).strip()))
    return out


if __name__ == "__main__":
    sys.exit(main())
