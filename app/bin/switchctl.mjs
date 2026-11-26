#!/usr/bin/env node
// switchctl —— NetPanel 命令行入口。实现见 src/cli/index.mjs (可以直接在测试里调用, 不必起子进程)。

import { runCli } from '../src/cli/index.mjs';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
  },
);
