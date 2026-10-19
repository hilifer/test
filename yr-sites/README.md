# YAORONG / YR GRID 独立销售站

两个 AI 自动销售型独立站，共用一套代码：

- `sites/led`：**YAORONG** 外贸 LED 照明站（英文，部署在北美）
- `sites/grid`：**YR GRID** 光伏 · 储能 · 充电桩站（英文 + 中文，部署在东南亚）
- `server`：AI 销售后端（对话、报价、线索、MCP、后台）+ SEO/GEO 内容智能体 + 销售→交付闭环（报价/PI、订单、库存、发货物流、售后、客户中心、金蝶对接）
- `shared`：聊天组件、销售规则引擎、给 AI 读的机器可读层
- `deploy`：Docker / Caddy 部署文件，按区域分成 `led-na`、`grid-sea` 两套

部署、运营和上线前的数据替换清单见 **[docs/部署手册.md](docs/部署手册.md)**；状态与编号规则见 **[docs/数据字典.md](docs/数据字典.md)**。
