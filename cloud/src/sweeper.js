// 云端内部 tick（非端口）—— 契约 §6.13。
//
// 【它唯一被允许碰 task_status 的理由】它改的是**镜像新鲜度**（mirror），
// 不是执行真相：state / outcome 一个字节都不动。这正是设计 §6.2
// 「机器掉线时云端不动任何任务状态」的原话——任务在人家机器上活得好好的，笔记本合盖而已。
// 真正的孤儿由本地 runner-checker 收（它本来就在干这事）。
import { pool } from './db.js';

export const SWEEP_INTERVAL_MS = 30_000;
// 90s 的推导（抄 multica 的推导方法而非抄它的数）：心跳 15s + tick 30s = 45s，留 45s buffer。
// multica 是 150s，因为它多一层 60s 的 Redis→DB flush 延迟；我们的心跳直写 last_seen_at，没有那 60s。
export const OFFLINE_AFTER_SEC = 90;

/**
 * 跑一轮：超时机器置 offline + 其任务镜像标 stale。
 * 一条 SQL 两个数据修改 CTE：gone 的 RETURNING 喂给 staled，同一快照内完成，不会漏标也不会重标。
 * @returns {Promise<{offlined:number, staled:number}>}
 */
export async function sweepOnce() {
  const { rows } = await pool.query(
    `with gone as (
       update machine set status = 'offline'
        where status = 'online' and last_seen_at < now() - make_interval(secs => $1::int)
        returning id
     ), staled as (
       update task_status ts set mirror = 'stale'
         from task t
        where ts.task_id = t.id and ts.mirror = 'live'
          and t.machine_id in (select id from gone)
        returning ts.task_id
     )
     select (select count(*)::int from gone) as offlined,
            (select count(*)::int from staled) as staled`,
    [OFFLINE_AFTER_SEC],
  );
  return rows[0];
}

/**
 * 起 30s tick。返回停止函数。
 * sweeper **不看 registration_key** —— rk 只管入场不管在场（§6.5.2）。
 */
export function startSweeper(log) {
  const timer = setInterval(() => {
    sweepOnce()
      .then((r) => { if (r.offlined || r.staled) log.info(r, 'sweeper：机器置 offline / 镜像标 stale'); })
      .catch((err) => log.error({ err }, 'sweeper 执行失败'));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
