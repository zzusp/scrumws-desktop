import path from 'node:path';
import { P } from '../paths.js';
import { readConfig } from '../runner-config.js';

// 平台守护 Runner Checker 的元信息（原在 dispatchers.js，2026-07-12 去派发器后独立于此）：
// 平台内置 job，不进任何注册表；扫孤儿 + 授权熔断复查（不启 claude、不消耗 API 额度）。
// 项目固有调度：常开不可停，只有节拍可从设置页调（runner-config.json.checkerIntervalSec），由看板进程内 scheduler 调度。
export const CHECKER = {
  id: 'runner-checker',
  label: 'Runner Checker',
  script: path.join(import.meta.dirname, 'runner-checker.js'),
  defaultIntervalSec: 60,
  logFile: P.runnerCheckerLog,
  hint: '扫孤儿 → 标 awaiting-human（sid 落 outcomeDetail，从看板处置；平台组件不外发通知）',
};
export function checkerIntervalSec() { return Number(readConfig().checkerIntervalSec) || CHECKER.defaultIntervalSec; }
