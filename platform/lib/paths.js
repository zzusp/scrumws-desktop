import path from 'node:path';
import os from 'node:os';

// 数据根 = 分身工作目录（runtime/、scripts/ 所在），桌面端启动时经 SCRUMWS_DATA_ROOT 注入；
// 默认指向本机分身目录（goal.md D2：运行时数据不搬家，app 只是平台进程的新宿主）。
export const ROOT = process.env.SCRUMWS_DATA_ROOT || 'D:\\baibu-agent';

// CC 官方项目目录名编码：盘符冒号与路径分隔符折成 '-'（D:\baibu-agent → D--baibu-agent）
const ccProjectName = ROOT.replace(/[:\\/]/g, '-');

// 2026-07-08 B6 迁移：运行时态从 docs/tmp（草稿区）迁至顶层 runtime/。键名 tmpDir 保留以免改动全部消费方，
// 语义 = 运行时态根目录。
export const P = {
  tmpDir:            path.join(ROOT, 'runtime'),
  runnerRoot:        path.join(ROOT, 'runtime', 'runner-state'),
  archiveRoot:       path.join(ROOT, 'runtime', 'runner-archive'),
  runnerCheckerLog:  path.join(ROOT, 'runtime', 'runner-checker.log'),
  // quota-block / auth-block sentinel 仍由 scripts 侧 .ps1 worker 链写在 runtime/dispatch-chat/ 下，checker 读侧复用
  quotaBlk:          path.join(ROOT, 'runtime', 'dispatch-chat', 'quota-block'),
  authBlk:           path.join(ROOT, 'runtime', 'dispatch-chat', 'auth-block'),
  // CC 官方 session jsonl 目录（worker-log 端点从这里读）
  ccProjectDir:      path.join(os.homedir(), '.claude', 'projects', ccProjectName),
};
