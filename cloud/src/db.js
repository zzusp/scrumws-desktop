// pg 连接池。连接串**只从 process.env.DATABASE_URL 读**：
// 任何片段都不得进源码 / 文档 / 日志 / 提交（契约 §11）。
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // 只说缺什么，不回显任何连接串片段
  throw new Error('缺少 DATABASE_URL 环境变量：云端服务无法启动。请从仓库根 .env 注入（切勿写死进源码）。');
}

export const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// 池内连接的异步错误（DB 重启 / 网络断）不该掀翻进程；由下一次查询自行重连报错。
pool.on('error', (err) => {
  console.error('[db] 空闲连接异常：', err.message);
});

/** 便捷查询。参数一律走占位符，杜绝拼串。 */
export const q = (text, params) => pool.query(text, params);

/**
 * 在一个事务里跑 fn(client)。抛异常自动回滚。
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* 回滚失败也要把原始错误抛出去 */ }
    throw err;
  } finally {
    client.release();
  }
}
