# -*- coding: utf-8 -*-
"""列出原厂页面里每个写接口是怎么提交的。适配器必须照这个来: 提交方式不对, 交换机直接断开连接。

    <form> 没写 method                          → 浏览器用 GET 提交, 全部字段 (含 token) 在查询串里; enctype 对 GET 不起作用
    <form method=post>                          → POST, application/x-www-form-urlencoded, 字段在请求体里
    <form method=post enctype=multipart/form-data> → POST, multipart/form-data
    不经 <form> 的写接口 (XHR / location.href)    → 单独列出来, 附所在文件和那一段代码

用法: python -I forms.py <页面目录> [<js 目录>...]
页面用 tools/sw.py save 存下来 (文件名形如 MainRpm_htm.txt, js 在另一个目录里)。只读, 不联网。
"""
import os
import re
import sys

ATTR = re.compile(r"""(\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""")
FORM = re.compile(r"<form\b([^>]*)>(.*?)</form>", re.I | re.S)
FIELD = re.compile(r'<(?:input|select|textarea|button)\b([^>]*)>', re.I)
# 不经 <form> 的提交: 页面脚本自己拼地址 (location.href / XHR), 或者把 token 拼到表单的 action 上
UNFORMED = re.compile(
    r"(location(?:\.href)?\s*=\s*[\"'][^\"']*\.cgi[^\"']*[\"']"
    r"|\.open\(\s*[\"'](?:GET|POST)[\"']\s*,\s*[^,)]+\.cgi[^)]*\)"
    r"|\.src\s*=\s*[\"'][^\"']*\.cgi)",
    re.I,
)
ACTION_TOKEN = re.compile(r"action\s*\+=\s*[^,;)]+", re.I)


def attrs(text):
    return {k.lower(): v.strip("\"' ") for k, v in ATTR.findall(text)}


def how(a):
    """浏览器提交这个表单的方式。"""
    if a.get("method", "").lower() != "post":
        return "GET (查询串)"
    return "POST multipart" if "multipart" in a.get("enctype", "").lower() else "POST 表单编码"


def cgi(action):
    m = re.search(r"([\w-]+\.cgi)", action or "")
    return m.group(1) if m else (action or "(本页)")


def forms(page_dir):
    rows = []
    for fn in sorted(os.listdir(page_dir)):
        if not fn.endswith(".txt"):
            continue
        text = open(os.path.join(page_dir, fn), encoding="utf-8", errors="replace").read()
        for m in FORM.finditer(text):
            a = attrs(m.group(1))
            names = [attrs(c).get("name", "") for c in FIELD.findall(m.group(2))]
            names = [n for n in names if n]
            rows.append((fn.replace("_htm.txt", ".htm"), cgi(a.get("action")), how(a), names))
    width = max((len(r[1]) for r in rows), default=0)
    print(f"{'接口':<{width}} | 提交方式          | 表单里的字段 (★ = token 在表单里)")
    for page, action, way, names in rows:
        print(f"{action:<{width}} | {way:<17} | {page}: {' '.join(('★' if n == 'token' else '') + n for n in names)}")


def unformed(roots):
    print("\n页面脚本自己提交的 (不经 <form>, 或者提交前把 token 拼到 action 上):")
    seen = set()
    for root in roots:
        for d, _, files in os.walk(root):
            for fn in sorted(files):
                if not fn.endswith((".txt", ".htm", ".html", ".js")):
                    continue
                text = open(os.path.join(d, fn), encoding="utf-8", errors="replace").read()
                for pattern in (UNFORMED, ACTION_TOKEN):
                    for m in pattern.finditer(text):
                        snippet = " ".join(text[max(0, m.start() - 60):m.end() + 70].split())
                        if snippet in seen:
                            continue
                        seen.add(snippet)
                        print(f"  [{fn}] …{snippet}…")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.stdout.reconfigure(encoding="utf-8")
    forms(sys.argv[1])
    unformed([sys.argv[1], *sys.argv[2:]])


if __name__ == "__main__":
    main()
