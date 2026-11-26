// 面板配置: 监听地址 / 端口 / 数据目录的来源与优先级。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { APP_ROOT, loadConfig } from '../src/core/config.mjs';
import { WEB_DIR } from '../src/http/server.mjs';
import { VERSION } from '../src/http/routes.mjs';

test('应用根目录算对了: 里面有 package.json、server.mjs、web/', () => {
  // 数据目录默认在 <app>/data 下, 根目录算错一层就会把设备密码写到 src/ 里去
  assert.ok(existsSync(join(APP_ROOT, 'package.json')), `APP_ROOT=${APP_ROOT} 下没有 package.json`);
  assert.ok(existsSync(join(APP_ROOT, 'server.mjs')));
  assert.ok(existsSync(join(APP_ROOT, 'web', 'index.html')));
  assert.equal(WEB_DIR, join(APP_ROOT, 'web'));
});

test('版本号读的是 package.json', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('配置: 默认值、config.json、环境变量的优先级', () => {
  const defaults = loadConfig(APP_ROOT, {});
  assert.equal(defaults.host, '127.0.0.1'); // 默认只允许本机访问
  assert.equal(defaults.port, 8208);
  assert.equal(defaults.dataDir, join(APP_ROOT, 'data'));

  const dir = mkdtempSync(join(tmpdir(), 'netpanel-cfg-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ host: '0.0.0.0', port: 9000, dataDir: 'my-data', switchUrl: 'http://ignored' }));
    const fromFile = loadConfig(dir, { PANEL_CONFIG: file });
    assert.equal(fromFile.host, '0.0.0.0');
    assert.equal(fromFile.port, 9000);
    assert.equal(fromFile.dataDir, join(dir, 'my-data')); // 相对路径以应用根目录为基准
    const fromEnv = loadConfig(dir, { PANEL_CONFIG: file, PANEL_PORT: '9100', PANEL_DATA_DIR: resolve(dir, 'abs') });
    assert.equal(fromEnv.port, 9100);
    assert.equal(fromEnv.dataDir, resolve(dir, 'abs'));
    assert.equal('switchUrl' in fromEnv, false, '设备地址不再来自配置文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置不合法时启动就报错, 而不是带着错误的配置运行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-cfg-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{ broken');
    assert.throws(() => loadConfig(dir, {}), /解析失败/);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 99999 }));
    assert.throws(() => loadConfig(dir, {}), /端口不合法/);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 'abc' }));
    assert.throws(() => loadConfig(dir, {}), /端口不合法/);
    writeFileSync(join(dir, 'config.json'), '[]');
    assert.throws(() => loadConfig(dir, {}), /JSON 对象/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
