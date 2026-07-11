import { start } from './server.js';

// 无壳直跑入口（开发对拍 / 排障）：node platform/standalone.js
// 端口占用保持旧看板语义：已有实例在跑 → 静默退出 0
start().catch((e) => {
  console.log(`启动失败：${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});
