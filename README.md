# dsh-wind-finance

Wind 万得金融分析能力的独立打包版本。一个 bundle 提供一个宿主工具 `wind_finance`，
负责**路由 → 取数 → 按日回执去重**，让金融问题只走 Wind 一条数据链路。

## 它解决什么

金融数据散落在多处时，最常见的三类事故是：同一份数据当天被取两次（额度白烧）、
交互式对话与后台脚本各走各的通道（行为不一致）、以及拿网页数据或模型记忆凑答案。

本包把这三条收进一个工具：

- **一个入口**：`wind_finance` 先按自然语言定位到正确的 Wind 工具，再执行它；
- **一次一份**：同一天重复调用命中回执，直接返回当天已取的结果，不消耗额度；
- **一条纪律**：认证 / 额度 / 网络失败如实报错误码，不换数据源兜底。

## 安装

```bash
dsh plugin add <本插件目录或仓库地址>
```

或从发布 tarball 安装：

```bash
dsh plugin add https://github.com/<owner>/dsh-wind-finance/releases/download/v0.1.0/dsh-wind-finance.tgz
```

安装后宿主会注册 `wind_finance` 工具，并向 system prompt 注入一段路由说明。
agent 侧的完整操作口径见 [SKILL.md](./SKILL.md)。

## 配置

凭据**不随包分发**。解析顺序：

1. 环境变量 `WIND_API_KEY`（或 `WIND_MCP_TOKEN`）；
2. 宿主 profile patch 中已配置的 `wind-tools` 凭据（只读读取，不复制、不打印）。

```bash
export WIND_API_KEY='<your-token>'
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WIND_API_KEY` | — | Wind API 凭据，首选 |
| `WIND_MCP_TOKEN` | — | `WIND_API_KEY` 的别名 |
| `WIND_MCP_ENDPOINT` | `https://mcp.wind.com.cn/vserver_wind_tools/mcp/` | 私有化部署时的元路由端点 |
| `WIND_MCP_SKILL_DIR` | `~/.agents/skills/wind-mcp-skill` | 批处理模式使用的 CLI 目录 |
| `DSH_HOME` | `~/.dsh` | 宿主 home，回执与缓存写在其下 |

## 用法

```jsonc
// 1) 定位工具
{ "question": "贵州茅台最新成交价和涨跌幅" }

// 2) 执行取数
{ "tool_name": "get_stock_price_indicators",
  "params": { "windcode": "600519.SH", "indexes": "中文简称,最新成交价,涨跌幅" } }

// 批处理（定时任务 / 脚本）
{ "mode": "batch", "server_type": "stock_data",
  "tool_name": "get_stock_price_indicators",
  "params": { "windcode": "600519.SH" } }
```

返回里的 `cached: true` 表示命中当天回执、结果来自当天早先的取数，不是估算值。

## 状态文件

```
$DSH_HOME/wind-finance/
  receipts/<YYYY-MM-DD>.json   # 当天每次调用的回执（成功/失败、耗时、工具名）
  cache/<YYYY-MM-DD>/*.json     # 对应的响应缓存，供当天复用
```

回执与缓存写在插件包之外，不污染包目录，也不会被打进发布产物。

## 验证

```bash
node --check index.js
node --check runner.js
node test/smoke.mjs            # 离线：结构与契约检查
WIND_SMOKE_LIVE=1 node test/smoke.mjs   # 联机：真实取一次数
```

## 发布前检查

- [ ] 无本机绝对路径、无客户名、无凭据、无 `__pycache__` / 二进制
- [ ] `node --check` 通过，`test/smoke.mjs` 全绿
- [ ] `WIND_API_KEY` 未出现在任何提交文件中

## 许可与依赖

宿主侧零 npm 依赖，只用 Node 内置模块。Wind 数据服务由 Wind 官方提供，
凭据与调用额度由使用者自行申请，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
