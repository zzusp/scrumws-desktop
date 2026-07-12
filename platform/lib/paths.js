import path from 'node:path';
import os from 'node:os';

// 数据根 = 运行时态目录（runtime/、scripts/ 所在），桌面端启动时经 SCRUMWS_DATA_ROOT 注入；
// 默认落用户主目录下的绝对路径 ~/.scrumws。不用相对路径：相对路径挂在启动 CWD 下，换目录启动即
// 指向另一处、还可能落在仓库内被 git clean 连锅端——曾导致看板任务"凭空消失"。
export const ROOT = process.env.SCRUMWS_DATA_ROOT || path.join(os.homedir(), '.scrumws');

// CC 官方项目目录名编码：盘符冒号与路径分隔符折成 '-'（D:\baibu-agent → D--baibu-agent）
const ccProjectName = ROOT.replace(/[:\\/]/g, '-');

// 2026-07-08 B6 迁移：运行时态从 docs/tmp（草稿区）迁至顶层 runtime/。键名 tmpDir 保留以免改动全部消费方，
// 语义 = 运行时态根目录。
export const P = {
  tmpDir:            path.join(ROOT, 'runtime'),
  runnerRoot:        path.join(ROOT, 'runtime', 'runner-state'),
  archiveRoot:       path.join(ROOT, 'runtime', 'runner-archive'),
  runnerCheckerLog:  path.join(ROOT, 'runtime', 'runner-checker.log'),
  // CC 官方 session jsonl 目录（worker-log 端点从这里读）
  ccProjectDir:      path.join(os.homedir(), '.claude', 'projects', ccProjectName),
};
