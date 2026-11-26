// 前端里不依赖 DOM 的纯函数 (labels.js)。可以直接在 Node 里测。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedPairs, parseRanges, portRanges, rate, rateShort, uptime } from '../web/js/labels.js';

const forwardAll = (n) => Array.from({ length: n }, (_, i) => ({ port: i + 1, lag: 0, forward: `1-${n}` }));

test('isolatedPairs: 所有端口互相可转发时没有隔离对', () => {
  assert.deepEqual(isolatedPairs(forwardAll(8), 8), []);
});

test('isolatedPairs: 端口 5 只能转发给 8 → 5 与 1-4、6-7 互相隔离, 每对只列一次且小端口在前', () => {
  const rules = forwardAll(8);
  rules[4].forward = '8';
  assert.deepEqual(isolatedPairs(rules, 8), [[1, 5], [2, 5], [3, 5], [4, 5], [5, 6], [5, 7]]);
});

test('isolatedPairs: 访客口 7、8 只能到上联口 1 → 7 和 8 与 2-6 隔离, 但彼此互通', () => {
  const rules = forwardAll(8);
  rules[6].forward = '1,7-8';
  rules[7].forward = '1,7-8';
  // 结果按"小端口在前、先列完 7 再列 8"以外的顺序无所谓, 这里按函数的实际顺序 (以较小的端口为主序) 比较
  assert.deepEqual(isolatedPairs(rules, 8), [[2, 7], [2, 8], [3, 7], [3, 8], [4, 7], [4, 8], [5, 7], [5, 8], [6, 7], [6, 8]]);
});

test('isolatedPairs: 规则对象用 id 而不是 port 时也能识别', () => {
  assert.deepEqual(isolatedPairs([{ id: 2, forward: '1' }], 3), [[2, 3]]);
});

test('parseRanges / portRanges 互为逆运算', () => {
  assert.deepEqual(parseRanges('1-4,7'), [1, 2, 3, 4, 7]);
  assert.equal(portRanges([1, 2, 3, 4, 7]), '1-4,7');
  assert.equal(portRanges([5]), '5');
  assert.equal(portRanges([]), '—');
});

test('速率与运行时间的格式化', () => {
  assert.equal(rateShort(0), '0');
  assert.equal(rateShort(40), '40K');
  assert.equal(rateShort(1706), '1.71M');
  assert.equal(rate(1000000), '1.00 Gbps');
  assert.equal(uptime(965852).text, '11 天 4 小时 17 分 32 秒'); // 11×86400 + 4×3600 + 17×60 + 32
});
