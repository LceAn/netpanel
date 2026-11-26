// 解析固件页面 <script> 里的 `var a = {...}, b = [...]`; 声明。
// 只认字面量 (对象/数组/字符串/数字/布尔/null/new Array), 不求值任何表达式,
// 所以交换机返回的内容永远不会被当作代码执行。

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER = /^[-+]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

class ParseError extends Error {}

class Parser {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.n = src.length;
  }

  /** 跳过空白与注释。 */
  ws() {
    const { s } = this;
    for (;;) {
      while (this.i < this.n && /\s/.test(s[this.i])) this.i++;
      if (s.startsWith('//', this.i)) {
        const e = s.indexOf('\n', this.i);
        this.i = e < 0 ? this.n : e;
      } else if (s.startsWith('/*', this.i)) {
        const e = s.indexOf('*/', this.i + 2);
        this.i = e < 0 ? this.n : e + 2;
      } else {
        return;
      }
    }
  }

  peek() {
    return this.i < this.n ? this.s[this.i] : '';
  }

  eat(ch) {
    if (this.peek() !== ch) throw new ParseError(`期望 '${ch}', 实际 '${this.peek()}' @${this.i}`);
    this.i++;
  }

  ident() {
    const { s } = this;
    if (this.i >= this.n || !IDENT_START.test(s[this.i])) return null;
    let j = this.i + 1;
    while (j < this.n && IDENT_PART.test(s[j])) j++;
    const name = s.slice(this.i, j);
    this.i = j;
    return name;
  }

  /** 解析整个 script, 返回所有能识别的顶层变量。 */
  run() {
    const out = Object.create(null);
    for (;;) {
      this.ws();
      if (this.i >= this.n) break;
      const start = this.i;
      try {
        if (/^var\b/.test(this.s.slice(this.i, this.i + 4))) this.varStatement(out);
        else if (/^function\b/.test(this.s.slice(this.i, this.i + 8))) this.skipBlock('{', '}');
        else this.i++; // 其它语句逐字符跳过
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.i = Math.max(this.i, start + 1);
        this.skipToStatementEnd(false); // 解析中途失败: 跳到语句结尾的 ;
      }
    }
    return out;
  }

  varStatement(out) {
    this.i += 3;
    for (;;) {
      this.ws();
      const name = this.ident();
      if (!name) throw new ParseError(`期望变量名 @${this.i}`);
      this.ws();
      if (this.peek() !== '=') {
        out[name] = undefined; // `var x;` 声明未赋值
      } else {
        this.i++;
        this.ws();
        const value = this.value();
        this.ws();
        const after = this.peek();
        // 固件有些声明不写分号直接换行接下一条 var/function (JS 自动补分号)
        const nextStmt = /^var\b/.test(this.s.slice(this.i, this.i + 4)) || /^function\b/.test(this.s.slice(this.i, this.i + 8));
        // 值后面还跟着运算符/调用等, 说明这不是纯字面量表达式 → 丢弃整个声明
        if (!nextStmt && after !== ',' && after !== ';' && after !== '') {
          delete out[name];
          this.skipToStatementEnd();
          break;
        }
        out[name] = value;
      }
      const c = this.peek();
      if (c === ',') {
        this.i++;
        this.ws();
        continue;
      }
      if (c === ';') this.i++;
      break;
    }
  }

  /** 从当前位置跳到当前语句末尾, 跳过字符串与括号内部; 遇到下一条 var/function 也停。
   *  stopAtComma: 值后面还有非字面量表达式时, 声明可能在顶层 , 处继续。 */
  skipToStatementEnd(stopAtComma = true) {
    let depth = 0;
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === '"' || c === "'" || c === '`') {
        try {
          this.string(c);
        } catch {
          this.i = this.n; // 字符串没闭合: 直接到结尾
        }
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (c === ';' || (stopAtComma && c === ',')) break;
        if (/^var\b/.test(this.s.slice(this.i, this.i + 4)) || /^function\b/.test(this.s.slice(this.i, this.i + 8))) break;
      }
      this.i++;
    }
  }

  /** 从 pos 处的开括号开始, 跳到配对的闭括号之后。 */
  skipBlock(open, close) {
    let depth = 0;
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === '"' || c === "'" || c === '`') {
        this.string(c);
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        this.i++;
        return;
      }
      this.i++;
    }
  }

  value() {
    this.ws();
    const c = this.peek();
    if (c === '{') return this.object();
    if (c === '[') return this.array(']');
    if (c === '"' || c === "'" || c === '`') return this.string(c);
    if (c === '-' || c === '+' || c === '.' || /\d/.test(c)) return this.number();
    const id = this.ident();
    if (id === null) throw new ParseError(`无法识别的值 @${this.i}`);
    switch (id) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'undefined': return undefined;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case 'new': return this.newExpr();
      default:
        throw new ParseError(`非字面量标识符 ${id}`);
    }
  }

  newExpr() {
    this.ws();
    const ctor = this.ident();
    this.ws();
    if (ctor === 'Array' && this.peek() === '(') return this.array(')', true);
    if (ctor === 'Object') {
      this.eat('(');
      this.eat(')');
      return {};
    }
    throw new ParseError(`不支持 new ${ctor}()`);
  }

  number() {
    const m = NUMBER.exec(this.s.slice(this.i, this.i + 40));
    if (!m) throw new ParseError(`非法数字 @${this.i}`);
    this.i += m[0].length;
    const raw = m[0];
    return /^[-+]?0[xXbBoO]/.test(raw) ? Number.parseInt(raw, 0) : Number(raw);
  }

  string(quote) {
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.n) throw new ParseError('字符串未闭合');
      const c = this.s[this.i++];
      if (c === quote) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (e === 'x') {
        out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16));
        this.i += 2;
      } else if (e === 'u') {
        out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
        this.i += 4;
      } else if (e === '\r') {
        if (this.s[this.i] === '\n') this.i++; // 行 continuation
      } else if (e === '\n') {
        // 行 continuation
      } else {
        out += simple[e] ?? e;
      }
    }
  }

  object() {
    this.eat('{');
    const out = {};
    for (;;) {
      this.ws();
      if (this.peek() === '}') {
        this.i++;
        return out;
      }
      let key;
      const c = this.peek();
      if (c === '"' || c === "'") key = this.string(c);
      else if (c === '[') {
        this.i++;
        key = String(this.value());
        this.ws();
        this.eat(']');
      } else {
        key = this.ident();
        if (key === null) {
          const m = /^\d+/.exec(this.s.slice(this.i, this.i + 12));
          if (!m) throw new ParseError(`非法对象键 @${this.i}`);
          key = m[0];
          this.i += key.length;
        }
      }
      this.ws();
      this.eat(':');
      out[key] = this.value();
      this.ws();
      const after = this.peek();
      if (after === ',') {
        this.i++;
        continue;
      }
      if (after === '}') {
        this.i++;
        return out;
      }
      throw new ParseError(`对象里期望 , 或 } @${this.i}`);
    }
  }

  array(close, fromCtor = false) {
    this.eat(fromCtor ? '(' : '[');
    const out = [];
    for (;;) {
      this.ws();
      if (this.peek() === close) {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      const after = this.peek();
      if (after === ',') {
        this.i++;
        continue;
      }
      if (after === close) {
        this.i++;
        return out;
      }
      throw new ParseError(`数组里期望 , 或 ${close} @${this.i}`);
    }
  }
}

/**
 * 解析一段 script 源码里的顶层变量声明。
 * 个别声明解析失败不影响其它声明。
 * @returns {Record<string, unknown>}
 */
export function parseVars(src) {
  return new Parser(String(src)).run();
}

/** 取出 HTML 里所有 <script> 的内容 (按出现顺序)。 */
export function scripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
