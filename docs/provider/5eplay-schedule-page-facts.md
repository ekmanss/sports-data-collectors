# 5EPlay CS2 赛程页事实基线

本文记录 [`/csgo/matches`](https://event.5eplay.com/csgo/matches) 及其公开数据接口的现实行为，
作为赛程发现功能的实现依据。它不描述我们希望提供方如何工作，也不把当前代码行为反过来当作提供方
事实。

最后核验：2026-07-21。瞬时比赛、比分和行数仅用于证明形状或边界，不构成永久常量。

## 证据等级和维护规则

- **已观察**：在公开页面、HTTP 响应或连续真实比赛观察中直接看到。
- **历史观察**：来自 Git 历史中仍可复查的原始调查；需要重新验证后才能升级为当前事实。
- **当前实现**：仅说明仓库现在如何处理，不证明外部协议永远如此。
- **未知**：证据不足，禁止靠字段名、页面文案或单一样本补全。

新增或修改事实时必须附观察日期和来源。短期抓包可在验证后删除，但其稳定结论、反例和未知项必须先
沉淀到本文或比赛详情事实文档。账号凭据、Cookie、MQTT 授权和个人数据不得进入文档或 fixture。

## 页面和数据通道

1. **已观察**：赛程页是 HTTP 数据驱动的普通 React DOM。历史表面清点未发现 Canvas、WebGL、
   WebGPU、视频、iframe 或 SVG 特效目标，因此 `web-shader-extractor` 对渲染提取本身不适用。
   删除它的原始 DOM/网络批量产物是合理的；丢失其中已验证的协议事实则不合理。来源：
   [历史 scout card](https://github.com/ekmanss/sports-data-collectors/blob/886291d38af48323331142897f8f9c5edc93e9ba/web-shader-extractor/scout-card.json)、
   [历史协议调查](https://github.com/ekmanss/sports-data-collectors/blob/886291d38af48323331142897f8f9c5edc93e9ba/web-shader-extractor/5eplay-protocol-findings.md)。
2. **已观察**：页面当前显示日期分组、计划时间、BO 数、双方队伍、百分比、系列/地图比分、
   `进行中` 或 `赛前分析` 文案和赛事信息。页面文案是展示结果，不是精确比赛阶段的权威来源。
   来源：[公开赛程页](https://event.5eplay.com/csgo/matches)，2026-07-21 通过 Jina Reader 核验。
3. **已观察**：页面使用的公开列表接口为：

   ```text
   GET https://app.5eplay.com/api/tournament/session_list
       ?game_status=1&game_type=1&grades=&page={page}&limit=20
   ```

   当前成功响应外层包含 `success=true`、`errcode=0`，`data` 内包含 `matches` 和
   `state_ver`。来源：[公开列表接口（第一页）](https://app.5eplay.com/api/tournament/session_list?game_status=1&game_type=1&grades=&page=1&limit=20)、
   [当前协议说明](../../packages/5eplay/PROTOCOL.md)。
4. **未知**：`game_status=1` 的精确定义没有官方协议说明。它实际返回正在进行和未来比赛，不能按参数
   名称猜成“只返回 live”。

## 分页和排序

1. **已观察**：接口分页从 1 开始，请求固定 `limit=20`。2026-07-21 09:30 UTC 核验时，第 1 至
   6 页每页都返回 20 条；因此“本页正好 20 条”只说明下一页可能存在，不能证明一定存在，也不能证明
   总数为 20。来源：[公开列表接口](https://app.5eplay.com/api/tournament/session_list?game_status=1&game_type=1&grades=&page=1&limit=20)。
2. **已观察**：同日较早的真实验证读取前五页共 100 条，当前实现均可解码；其中包含尚未决定对阵方的
   TBD 行。来源：[2026-07-21 真实环境验证](../live-validation-2026-07-21.md)。
3. **当前实现**：一次 `schedule()` 只读取指定的一页，默认第 1 页；它保留提供方行顺序，不自动追页。
   `sourceCount` 是过滤前的原始行数，`mayHaveNextPage` 仅由原始行数是否等于 20 得出。来源：
   [schedule/load.ts](../../packages/5eplay/src/schedule/load.ts)、
   [集成说明](../../packages/5eplay/INTEGRATION.md)。
4. **未知**：提供方排序的完整规则、跨页数据变化时是否可能重复/漏行、最大页数和空尾页行为尚无连续
   证据。消费者不得把一次遍历当作事务一致的全量快照。

## 行结构

每条原始行当前包含 `mc_info`、`state`、`tt_info` 和 `like_data` 四个顶层对象。以下字段在
2026-07-21 的真实响应中出现；“出现”不等于永远非空。

### 比赛 `mc_info`

- 身份和时间：`id`、`plan_ts`、`game_type`、`format`；
- 阶段和展示：`tt_stage`、`tt_stage_desc`、`round_name`、`sort_num`、`display`、`tags`；
- 双方队伍：`t1_info`、`t2_info`；
- 其他页面字段：`grade`、`group_id`、`star`、`user_data`。

已观察的比赛 ID 形如 `csgo_mc_<数字>`，详情页规范 URL 为
`https://event.5eplay.com/csgo/matches/{id}`。`plan_ts` 是 Unix 秒，但计划时间会延迟和修改，越过
计划时间也不证明比赛已经开始。来源：[历史连续状态调查](https://github.com/ekmanss/sports-data-collectors/blob/886291d38af48323331142897f8f9c5edc93e9ba/web-shader-extractor/5eplay-protocol-findings.md)、
[当前集成说明](../../packages/5eplay/INTEGRATION.md)。

### 队伍 `t1_info` / `t2_info`

真实响应中出现 `id`、`disp_name`、`logo`、`country`、`rank`、`v_rank` 和 `bonus`。

- **已观察**：未来淘汰赛槽位可显示 `TBD`，队伍 ID 为空；不能制造假 ID。
- **已观察**：同一页可能混用 `hltv_team_*` 和 `csgo_tm_*` 身份命名空间；不能只截取数字或假定前缀
  相同。
- **未知**：TBD 逐步替换为真实队伍时是否保证比赛 ID 不变，尚未完成连续观察。

### 比赛状态 `state`

真实响应中出现：

- 系列状态和比分：`status`、`t1_score`、`t2_score`、`t1_quick_score`、
  `t2_quick_score`；
- 地图摘要：`bout_states`；
- 页面辅助字段：`live_status`、`round_num`、`video_status`、`highlight_status`、
  `has_forecast`、`has_expert_plan`、`dark_horse`、`drop_act`；
- 赔率相关字段：`t1_odds`、`t2_odds`、`t1_odds_percent`、`t2_odds_percent`。

2026-07-21 09:30 UTC 第一页的 20 条中，`state.status="1"` 有 3 条，`"0"` 有 17 条；
页面对应显示三场进行中比赛。该计数是瞬时样本。当前已观察/实现使用的含义为：`0` 或 `-1` 表示
未来，`1` 表示进行中，`2` 表示已结束；但赛程状态只用于发现，精确阶段必须读取详情 `/data`。
来源：[公开列表接口](https://app.5eplay.com/api/tournament/session_list?game_status=1&game_type=1&grades=&page=1&limit=20)、
[真实环境验证](../live-validation-2026-07-21.md)。

同日 `10:24:22Z` 至 `10:39:25Z` 的 clean-break 复验中，页面从三场进行中变为四场：
`csgo_mc_2395549` 到达计划时间后先切换为列表 `进行中`，但详情仍是图 1 未开。两次
`schedule()` 都返回 20 条并与页面顺序、粗状态、系列分和可见地图分一致。该链直接说明
`schedule.status=live` 可以早于任何正式地图证据，不能把它映射为 `map-live`。来源：
[clean-break live verification](../live-validation-2026-07-21.md#clean-break-follow-up-verification)。

### 地图摘要 `state.bout_states[]`

真实响应中出现 `bout_num`、`map_name`、`status`、`result`、双方正式/快速比分、回合数组、击杀、
时间和显示辅助字段。当前观察/实现使用 `-1` 或 `0` 为未开，`1` 为进行中，`2` 为已结算。

赛程摘要不是详情状态机的替代品：列表与详情请求不是原子读取，切换边界可能先后到达；
`quick_score` 也可能表示尚未结算回合的前瞻比分。地图是否真正打过、正式回合、图间状态和最终关闭
都必须由详情证据判断。来源：[当前协议说明](../../packages/5eplay/PROTOCOL.md)、
[LIVE-001](../live-validation-2026-07-21.md#live-001--a-newly-live-map-is-blocked-as-inconsistent)。

### 赛事 `tt_info`

真实响应中出现：`id`、`disp_name`、中英文缩写、`status`、`mode`、`grade`、
`grade_label`、`special_grade_label`、`special_color`、`logo`、`cover`、`color`、
`city_name`、`bonus`、`start_time`、`end_time`。

赛事状态描述的是赛事，不是当前比赛；真实样本中未来比赛所在赛事可已经是 `live`。提供方赛事起止时间
是无时区的本地字符串，目前没有证据可以安全转换为 UTC。

## BO 格式

1. **已观察**：`mc_info.format` 是字符串数字。2026-07-21 09:30 UTC 第一页 20 条全为
   `"3"`；第 4 页还真实出现一场 `"5"` 的未来总决赛。因此列表层现实范围不只 BO1/BO3。
2. **历史/需求事实**：BO1 必须被考虑，但当前事实集中还没有两条独立、完整的真实 BO1 生命周期。
3. **当前实现**：赛程模型把格式保留为正整数，所以可以发现 BO5；详情状态模型仅声明 BO1/BO3，且
   BO1 仍返回 `unsupported / format-unverified`。这不是提供方限制，而是证据门槛。
4. **未知**：BO1、BO5 的详情 `/data` 地图槽位形状、关闭向量、技术判罚和实时版本行为。未获得完整
   链路前不得把 BO3 状态向量机械裁剪或扩展。

## 赛程页能做与不能做的判断

赛程页适合：

- 发现进行中和未来比赛 ID；
- 展示计划时间、双方、赛事、阶段、BO 数和粗粒度系列/地图摘要；
- 决定接下来对哪个 ID 调用详情快照。

赛程页不能可靠确认：

- 图 1 尚未开始、某图进行中、两图之间或比赛稳定关闭；
- 当前正式比分和回合是否已结算；
- 玩家、事件、分析和历史数据是否属于正式比赛时间线；
- 计划时间已到是否等于开赛；
- 赛事 `tt_info.status` 是否等于比赛状态。

因此赛程 `live/upcoming` 必须被视为 discovery hint。涉及交易或不可逆决策时，应以详情页事实文档
定义的多源一致性和稳定关闭门槛为准。参见
[`5eplay-match-page-facts.md`](5eplay-match-page-facts.md)。

## 产品范围与忽略字段

按当前需求，赛程能力不返回 5EPlay 自身赔率、直播源或赛后内容。公开响应里存在赔率、视频、预测、
热度等页面辅助字段这一事实仍保留在本文，但“上游有字段”不等于“产品应暴露字段”。当前实现只输出
身份、计划时间、BO、队伍、系列比分、地图摘要、赛事和阶段。来源：
[schedule/load.ts](../../packages/5eplay/src/schedule/load.ts)。

## 已知未知和下一批证据

- BO1 从赛前到稳定关闭的两条独立完整轨迹；
- BO5 详情页的地图槽位和关闭语义；
- 取消、延期、改对阵方、删除比赛和比赛 ID 是否保持稳定；
- 列表与详情在所有状态边界的领先/滞后关系；
- 跨页变化导致重复或漏行的实际行为；
- 提供方对 `state_ver` 的正式语义；
- 非 20 的 `limit`、极大页码和空尾页是否有稳定契约。

这些项目在获得直接证据前保持未知；实现应显式保守失败，而不是用页面文字或单字段猜测。
