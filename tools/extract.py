"""从原厂页面里提取协议要点: 页首数据块、表单、控件、提交函数、依赖的 JS。

用法: python -I extract.py <页面目录> [页面名过滤...]
"""
import os
import re
import sys


def brace_block(text, start):
    """从 text[start] 处的 '{' 开始, 返回到配对 '}' 的整段。"""
    depth, i, in_str, quote = 0, start, False, ""
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                in_str = False
        elif c in "\"'":
            in_str, quote = True, c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return text[start:]


def functions(script):
    out = []
    for m in re.finditer(r"function\s+(\w+)\s*\([^)]*\)\s*\{", script):
        body = brace_block(script, script.index("{", m.end() - 1))
        out.append(f"  function {m.group(1)}{script[m.end():script.index('{', m.end() - 1)]}{body}")
    return out


def main():
    d = sys.argv[1]
    names = sys.argv[2:]
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".txt") or (names and not any(n.lower() in fn.lower() for n in names)):
            continue
        text = open(os.path.join(d, fn), encoding="utf-8").read()
        print(f"\n################ {fn}  ({len(text)} chars)")
        scripts = re.findall(r"<script[^>]*>(.*?)</script>", text, flags=re.S | re.I)
        # 1) 页首数据块: 第一个以 var 开头的 script
        if scripts:
            print("--- DATA")
            print(scripts[0].strip())
        # 2) 依赖 JS/CSS
        deps = re.findall(r"inc(?:Js|Css)\(\"([^\"]+)\"\)", text)
        print("--- DEPS:", " ".join(deps))
        # 3) 表单与控件
        forms = re.findall(r"<form[^>]*>", text, flags=re.I)
        if forms:
            print("--- FORMS:", " | ".join(forms))
        ctrls = re.findall(r"<(?:input|select|textarea)\b[^>]*>", text, flags=re.I)
        ctrls = [re.sub(r"\s+(?:style|class|size|width|onclick|onchange|onkeypress|tabindex)=(\"[^\"]*\"|\w+)", "", c) for c in ctrls]
        if ctrls:
            print("--- CONTROLS:")
            for c in ctrls:
                print("   ", c)
        # 4) 内联函数 (跳过页首数据块)
        for s in scripts[1:]:
            fs = functions(s)
            if fs:
                print("--- FUNCTIONS:")
                for f in fs:
                    print(f)
        # 5) 明文提示 / 注意事项
        notes = re.findall(r"(?:注意|提示)[：:]\s*</span>.*?</table>", text, flags=re.S)
        if notes:
            print("--- NOTES:")
            for n in notes:
                print("   ", " ".join(re.sub(r"<[^>]+>", " ", n).split()))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
