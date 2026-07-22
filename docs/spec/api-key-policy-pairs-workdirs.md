# API 密钥组合策略与工作目录选择

## 目标

API 密钥不再把模型和推理强度当作两份独立多选白名单，而是维护有序的 `model + effort` 组合；同时，可访问目录只能从「工作目录」菜单维护的目录中选择。

## 现状与问题

- 现有 `allowedModels × allowedEfforts` 在外部建任务时分别校验，实际授予了所有交叉组合，不能表达“模型 A 只允许 effort X、模型 B 只允许 effort Y”。
- 目录以 textarea 自由输入，和新建任务所使用的 `runner-config.json.workDirectories` 脱节。

## 方案

1. 新密钥存 `allowedModelEfforts: [{ model, effort }]`，顺序即默认组合；外部任务请求的 model 和 effort 必须共同命中同一条组合。
2. 对存量密钥（只有 `allowedModels`、`allowedEfforts`）在读取时按原笛卡尔积解释，保持原授权范围；新建或编辑均写入组合字段，并继续回显两份派生数组给旧调用方。
3. `allowedCwds` 必须是当前 `workDirectories` 的精确成员；外部任务仍可在已授权目录的子目录运行。
4. API 密钥弹窗将 Provider 独立成一行，复用新建任务的 Provider 自绘下拉；组合行只展示复用的 model + effort 合并选择控件。工作目录使用紧凑的可点击多选列表，直执权限使用开关式复选控件；没有已配置目录时，引导用户前往「工作目录」菜单维护。

## 验证

- API 验收脚本覆盖默认组合、允许组合、拒绝交叉组合及未配置工作目录拒绝。
- 双 provider 验证覆盖 Codex 密钥和旧数组格式兼容。
- 运行 Node 语法检查、内联脚本编译和 `git diff --check`。
