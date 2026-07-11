// 平台核宿主：配置 → 环境注入（platform 模块在 import 时读取 SCRUMWS_*），再动态加载。
// 必须先注env后 import——paths.js 的 ROOT 在模块加载期定值。
export async function startServer(config) {
  process.env.SCRUMWS_DATA_ROOT = config.dataRoot;
  process.env.SCRUMWS_PORT = String(config.port);
  if (!config.schedulerEnabled) process.env.DASHBOARD_NO_SCHEDULER = '1';
  const { start } = await import('../platform/server.js');
  return start();
}
