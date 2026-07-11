const http = require('http');

// G4 平台核迁移前的占位 server：只证明「壳生命周期 + 端口链路」通。
// 迁移后此文件改为装载 platform/ 下的平台核（server + 调度器 + checker）。
function startServer(config) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>scrumws</title>'
        + '<body style="background:#111;color:#eee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">'
        + '<div>scrumws-desktop 骨架已启动（G3 占位页，平台核迁移中）</div>');
    });
    server.listen(config.port, '127.0.0.1', () => resolve({ port: config.port, server }));
    server.on('error', reject);
  });
}

module.exports = { startServer };
