// 统一时间工具：本机为 Asia/Shanghai，台账 / 日志时间串格式均为 'yyyy-MM-dd HH:mm:ss'（本地时区）。

const pad = (n) => String(n).padStart(2, '0');

export function fmt(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 把 'yyyy-MM-dd HH:mm:ss' 当作本地时间解析（替空格为 T，避免被当 UTC）。
export function parse(s) {
  if (!s) return null;
  const d = new Date(String(s).trim().replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

// 相对时间文案：刚刚 / Nmin 前 / Nh 前
export function ago(s, now = new Date()) {
  const d = parse(s);
  if (!d) return { text: '—', sec: null };
  const sec = Math.max(0, Math.round((now - d) / 1000));
  let text;
  if (sec < 70) text = '刚刚';
  else if (sec < 3600) text = `${Math.round(sec / 60)}min 前`;
  else text = `${Math.round((sec / 3600) * 10) / 10}h 前`;
  return { text, sec };
}
