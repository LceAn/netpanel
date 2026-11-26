// 用合成夹具 (格式与真机页面首个 <script> 的数据声明一致) 验证 jslite 解析器对每个页面都能解析出变量。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseVars, scripts } from '../src/core/jslite.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// 合成夹具: 只含设备页面首个 <script> 里的数据声明, 身份信息 (MAC / IP / 用户名) 都是虚构的
const FIXTURES = join(HERE, 'fixtures', 'rpm'); // HERE 以路径分隔符结尾

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));

test('夹具目录存在且有页面', () => {
  assert.ok(files.length >= 20, `只找到 ${files.length} 个页面`);
});

for (const file of files) {
  test(`解析 ${file}`, () => {
    const vars = parseVars(readFileSync(join(FIXTURES, file), 'utf8'));
    assert.ok('tip' in vars, '应有 tip 变量');
    assert.equal(typeof vars.tip, 'string');
  });
}

test('解析对象/数组/十六进制/负数/字符串', () => {
  const vars = parseVars(`
    var a = {x:[1,2,0xFF,-1,], y:'it\\'s', "z": "中", w: true, n: null};
    var b = new Array(5, 0, 0);
    var c = -1, d = 1.5, e;
  `);
  assert.deepEqual(vars.a, { x: [1, 2, 255, -1], y: "it's", z: '中', w: true, n: null });
  assert.deepEqual(vars.b, [5, 0, 0]);
  assert.equal(vars.c, -1);
  assert.equal(vars.d, 1.5);
  assert.equal(vars.e, undefined);
});

test('非字面量表达式被丢弃且不影响后续声明', () => {  const vars = parseVars(`
    var logonInfo = new Array(1, 0, 0);
    var curEncryptType = "undefined" == typeof encryptType ? 0 : encryptType, curUserMinLenth = 5;
    var g_Lan = 0;
    function doClear(e) { var inner = {a: 1}; return "var fake = 1;"; }
    var after = 'ok';
  `);
  assert.deepEqual(vars.logonInfo, [1, 0, 0]);
  assert.equal('curEncryptType' in vars, false);
  assert.equal('inner' in vars, false);
  assert.equal('fake' in vars, false);
  assert.equal(vars.g_Lan, 0);
  assert.equal(vars.after, 'ok');
});

test('声明末尾省略分号 (自动补分号) 也能正确断句', () => {
  const vars = parseVars('var a = [0,1]\nvar b = {x: 1}\nvar tip = "";');
  assert.deepEqual(vars.a, [0, 1]);
  assert.deepEqual(vars.b, { x: 1 });
  assert.equal(vars.tip, '');
});

test('截断/损坏的输入不会抛异常', () => {
  for (const bad of ['', 'var', 'var a = {b: [1,2', 'var a = "unterminated', 'var a = foo(bar); var b = 1;']) {
    assert.doesNotThrow(() => parseVars(bad));
  }
  assert.equal(parseVars('var a = foo(bar); var b = 1;').b, 1);
});
