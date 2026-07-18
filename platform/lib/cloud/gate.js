// §7.2 / 决策 8+9：自动执行闸门。**本地算，云端说了不算**——云端只提供输入
//（intent.autoRun 是「意愿」、createdBy 是「谁派的」），结论由本机配置 + 本机 identity 定。
// 闸门的唯一去处是 createTask 的 plan 入参：autoExec=false → 落 plan 等人在看板点确认。
// ⚠ 真正的遏制是 cwd 白名单（cwd-allow.js），不是这个档位：档位管「要不要问一句」，白名单管「能瞄到哪」。

const MODES = new Set(['off', 'owner-only', 'on']);

/** 缺省 / 脏值 → 'owner-only'（§7.1 的默认档）。脏值退到默认档而不是抬到 'on' —— 打错字不该放宽。 */
export function acceptAutoRunMode(cfg) {
  const v = cfg?.acceptAutoRun;
  return MODES.has(v) ? v : 'owner-only';
}

/**
 * autoExec = intent.autoRun ∧ ( local==='on' ∨ (local==='owner-only' ∧ 发起人===机器主人) )
 * @param {{intent:object, cfg:object, identity:object}} args
 * @returns {boolean} true = 直接跑（createTask 的 plan=false）；false = 落 plan 等人点确认
 */
export function computeAutoExec({ intent, cfg, identity }) {
  if (!intent?.autoRun) return false;                 // 云端没勾 → 一票否决
  const mode = acceptAutoRunMode(cfg);
  if (mode === 'on') return true;
  if (mode !== 'owner-only') return false;            // 'off'
  const owner = identity?.ownerUserId;
  const creator = intent?.createdBy?.userId;
  // 两边都必须是非空字符串且严格相等；任一缺失 → 失配 → 落 plan（fail-closed）。
  // P1 升级路径：老 identity.json 没有 ownerUserId → 恒 false → 一切云端任务落 plan（契约 §7.5）。
  return typeof owner === 'string' && owner.length > 0 && owner === creator;
}
