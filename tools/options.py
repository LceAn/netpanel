"""打印页面里每个 <select> 的完整内容(含 option), 以及写死的 option 文案。

用法: python -I options.py <页面目录> <页面名过滤> [...]
"""
import os
import re
import sys


def main():
    d, names = sys.argv[1], sys.argv[2:]
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".txt") or not any(n.lower() in fn.lower() for n in names):
            continue
        text = open(os.path.join(d, fn), encoding="utf-8").read()
        print(f"\n################ {fn}")
        for m in re.finditer(r"<select\b.*?</select>", text, flags=re.S | re.I):
            block = re.sub(r"\s+(?:style|class|width|onclick|onchange|onkeypress|tabindex)=(?:\"[^\"]*\"|\w+)", "", m.group(0))
            print("  ", " ".join(block.split())[:700])
        # document.write 动态生成的 option
        for m in re.finditer(r"docW\(\"<option[^;]{0,400}", text):
            print("   JS:", m.group(0)[:400])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
