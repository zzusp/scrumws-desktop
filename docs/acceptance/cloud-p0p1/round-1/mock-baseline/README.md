# mock-baseline —— blocker ① 的根因物证（**别再用这里的 mock**）

前端 agent 当初自己搭了 `mock-cloud-server.mjs` 托管静态文件来自验，于是**从没碰过真的
`cloud/src/server.js`**——而真 server 压根没装 `@fastify/static`、把非 API 路径全回成 JSON 404。
mock 一路绿灯，真实部署里整个 Web 界面不可达。见 `../../round-1.md` §1 blocker ①。

这些 png 是对着 mock 拍的，且当时的 UI 已被 round-2 重做（原生 select 换成自研 dropdown、加了暗色主题），
**不代表当前形态**。当前形态的截图看 `../shots/` 与 `../../round-2/`。

留档只为记住这个教训：**自验的 mock 会把「没接线」验成绿的**。要验就对着真服务验。
