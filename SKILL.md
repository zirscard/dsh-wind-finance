---
name: wind-finance
description: 万得 Wind 金融数据取数与分析技能。把金融问题路由到正确的 Wind 数据域（股票 / 基金 / 指数 / 债券 / 公告新闻 / 宏观指标 / 跨标的聚合），只基于 Wind 返回值作答，并按日回执去重以避免重复消耗额度。触发词：行情、最新价、涨跌幅、K线、选股、筛选、市值、估值分位、财务、股东、持仓、基金、ETF、指数、板块、债券、公告、年报、季报、快讯、新闻、宏观、CPI、GDP、汇率、行业指标、加权平均、排名、Wind。
---

# Wind 金融数据（wind-finance）

> 定位：**唯一金融数据入口**。凡涉及金融事实（行情、财务、基金、指数、债券、公告、新闻、宏观、聚合指标），
> 一律走本技能取数，只报告 Wind 返回值，不补常识、不补点评。
>
> 工具：`wind_finance`（宿主注册，插件 `dsh-wind-finance` 提供）。

## 一、什么时候用

| 用户诉求 | 处理方式 |
|---|---|
| 金融事实类（行情/财务/基金/公告/宏观/聚合） | **必须**用本技能取数，不得用网页搜索、公开页面或模型记忆替代 |
| 估值 / 复盘 / 选股 / 仓位 / 回测等方法论 | 本技能只提供**数据底座**；方法论另有专门工作流技能，二者都要用 |
| 纯概念解释、非数据类常识 | 正常回答，不必取数 |

## 二、调用协议（两步）

**第 1 步 · 定位工具**

```json
{ "question": "贵州茅台最新成交价和涨跌幅" }
```

返回候选 Wind 工具（`tool_name` + 参数 schema）。

**第 2 步 · 执行取数**

```json
{ "tool_name": "get_stock_price_indicators",
  "params": { "windcode": "600519.SH", "indexes": "中文简称,最新成交价,涨跌幅" } }
```

参数名与取值**必须**来自第 1 步返回的 schema，不得凭记忆写。

**批处理模式**（定时任务 / 脚本，不用于对话取数）：

```json
{ "mode": "batch", "server_type": "stock_data",
  "tool_name": "get_stock_price_indicators",
  "params": { "windcode": "600519.SH" } }
```

## 三、路由表（七个数据域）

| `server_type` | 覆盖 | 工具 |
|---|---|---|
| `stock_data` | 股票筛选、行情、K线、分钟线、基本档案、财务、股东、事件、技术、风险 | `search_stocks` `get_stock_price_indicators` `get_stock_quote` `get_stock_kline` `get_stock_basicinfo` `get_stock_fundamentals` `get_stock_equity_holders` `get_stock_events` `get_stock_technicals` `get_risk_metrics` |
| `fund_data` | 基金/ETF/LOF 筛选、行情、K线、分钟线、档案、财务、持仓、业绩、持有人、公司 | `search_funds` `get_fund_price_indicators` `get_fund_quote` `get_fund_kline` `get_fund_info` `get_fund_financials` `get_fund_holdings` `get_fund_performance` `get_fund_holders` `get_fund_company_info` |
| `index_data` | 指数/板块行情、K线、分钟线、档案、基本面、技术 | `get_index_price_indicators` `get_index_quote` `get_index_kline` `get_index_basicinfo` `get_index_fundamentals` `get_index_technicals` |
| `bond_data` | 债券档案、发债主体、行情估值、主体财务 | `get_bond_basicinfo` `get_bond_issuer_info` `get_bond_market_data` `get_bond_financial_data` |
| `financial_docs` | 公告、年报、季报、招股书、财经新闻 | `get_company_announcements` `get_financial_news` |
| `economic_data` | 宏观、行业、汇率 EDB 指标 | `search_economic_indicator` `query_economic_indicator_data` |
| `analytics_data` | 跨标的聚合、加权平均、排名、复合指标推导 | `get_financial_data` |

**仲裁顺序**（意图多义时按序命中，命中即停）：

1. 公告 / 年报 / 季报 / 招股书 / 监管披露 → `get_company_announcements`
2. 新闻 / 快讯 / 报道 / 评论 → `get_financial_news`
3. 宏观 / 行业 / 汇率 EDB 指标（**即使没出现"宏观"二字**）→ 先 `search_economic_indicator` 确认代码，再 `query_economic_indicator_data` 取序列
4. 未指定标的的筛选 → 对应域的 `search_*`
5. 最新价 / 涨跌幅 / 成交量 / K线 / 分钟线 / 区间走势 → 对应域行情工具；**历史区间一律走 K线**
6. 财务 / 股本 / 股东 / 事件 / 技术 / 风险 / 持仓 / 业绩 → 对应域自然语言工具

## 四、五条硬规则

1. **不许用网页替代。** 金融事实必须来自 Wind 返回值。网页搜索、公开页面、模型记忆都不算数。
2. **`analytics_data` 不是万能入口。** 行情、K线、分钟线、价格指标一律走专项工具；标的多了就拆多次调用再合并。它只做跨标的聚合与推导，且更耗额度。
3. **单位不自己换算。** 单位的量级以返回体自带元数据为准（`data.unit`、列 `unit`、`meta.unit` / `meta.magnitude`）。元数据没给就保留原值并说明单位未知。
4. **标的认不出就问。** 要求用户给准确全称或 Wind 标准代码，**不得自行补交易所后缀或把名称猜成代码**。
5. **不许用别的源兜底。** 认证失败、额度耗尽、网络不通、后端不可用时直接报错误码，不得切 `analytics_data` 或其它数据源冒充成功。

## 五、三条防重复纪律

1. **同一数据当天只取一次。** 工具会先查当天回执，命中就返回当天已取过的结果（返回里 `cached` 标记为真），不再消耗额度。确实需要重取时传 `force: true`。
2. **交互式不走批处理通道。** 对话中一律用默认 interactive 模式；CLI 通道只给定时任务和脚本用。
3. **同一条通道共用一份额度。** MCP 通道与 CLI 通道共用同一个 API Key、同一份每日额度，不是两份额度。

## 六、收口规范

成功取到数据后，末尾附来源声明（中文问句用中文，英文问句用英文）：

> 数据来源于万得 Wind 金融数据服务。

> Data sourced from Wind Financial Data Service.

完成状态用以下枚举之一：`DONE`、`DONE_WITH_LIMITS`、`NO_RESULTS`、`BLOCKED_KEY`、`BLOCKED_QUOTA`、`BLOCKED_RUNTIME`、`OUT_OF_SCOPE`。

## 七、失败码对照

| `code` | 含义 | 处理 |
|---|---|---|
| `BLOCKED_KEY` | 没有可用 API Key | 提示在宿主环境配置 `WIND_API_KEY`；**不要**改用别的数据源 |
| `BLOCKED_QUOTA` | 触发限流或额度上限 | 停止批量请求，改用当天回执里的缓存结果 |
| `BLOCKED_RUNTIME` | 网络、后端或运行时不可用 | 如实上报错误码与消息 |
| `USAGE_ERROR` | 调用参数不完整（如批处理模式缺 `server_type`） | 按消息补齐参数重试 |
| `OUT_OF_SCOPE` | 请求不属于七个数据域 | 说明边界，不要伪造支持 |

## 八、扩展规则

- 新增取数能力 → 在 `core/routing.json` 的对应域 `tools` 数组登记工具名；
- 新增取数口径或仲裁规则 → 改 `core/routing.json` 的 `arbitration`，并同步本文件第三节；
- 额度分配策略 → 写在宿主侧，不在插件内硬编码。

本文件是 harness 直接读取的操作口径，改动必须与 `core/routing.json` 保持一致。
