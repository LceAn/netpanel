#!/usr/bin/env node
// NetPanel 启动入口。配置见 README (环境变量或 config.json)。
import { main } from './src/http/server.mjs';

main().catch((err) => {
  const reason = err?.code === 'EADDRINUSE' ? `端口已被占用: ${err.port}` : err?.message ?? err;
  console.error(`NetPanel 启动失败: ${reason}`);
  process.exit(1);
});
