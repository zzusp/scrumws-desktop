const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 8799,                  // 独立端口，避撞旧看板 8788（goal.md D4 双开防护）
  dataRoot: 'D:\\baibu-agent', // runtime/、scripts/ 所在根（goal.md D2 数据不搬家）
  schedulerEnabled: false,     // 开发/验证期默认关闭，防与旧看板双派发（D4）
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  const config = { ...DEFAULTS, ...saved };
  if (process.env.SCRUMWS_PORT) config.port = Number(process.env.SCRUMWS_PORT);
  if (process.env.SCRUMWS_DATA_ROOT) config.dataRoot = process.env.SCRUMWS_DATA_ROOT;
  if (process.env.SCRUMWS_SCHEDULER) config.schedulerEnabled = process.env.SCRUMWS_SCHEDULER === '1';
  return config;
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
