# 5EPlay 比赛详情页事实

本文是 `https://event.5eplay.com/csgo/matches/{matchId}` 及其公开数据源的长期事实基线，
用于约束采集器的领域模型、状态判定、数据完整性和后续验证。它不是当前实现说明，也不把
代码中的假设反过来当成上游事实。

赛程列表的现实行为单独记录在
[`5eplay-schedule-page-facts.md`](5eplay-schedule-page-facts.md)；实现契约和消费者说明不在本文
重复维护。

最后核对日期：2026-07-21。

## 证据等级与来源

本文逐条使用以下证据标签：

- **[OBS-20]**：2026-07-19 至 2026-07-20 的真实 HTTP、MQTT、DOM 和页面源码连续观察。
  原始调查在 Git 提交 `886291d` 的 `web-shader-extractor/` 中；总报告可用
  `git show 886291d:web-shader-extractor/5eplay-protocol-findings.md` 阅读，原始时间线和抓包
  位于同一提交的 `web-shader-extractor/evidence/`。这些文件已从当前工作树删除，但仍存在于
  Git 历史，不应把整个目录恢复为运行时代码或日常文档。
- **[FIX]**：当前仓库中从上述真实抓包裁剪、脱敏并附有原始 SHA-256 的最小证据。
  来源为 [`tests/fixtures/manifest.json`](../../packages/5eplay/tests/fixtures/manifest.json) 及其
  引用的 fixture。manifest 会明确区分 `real` 和 `synthetic`；合成分页信封不能证明提供方
  HTTP 分页响应的全部细节。
- **[OBS-21]**：2026-07-21 对当时第一页三场真实进行中比赛的验证和确定性诊断。
  来源为 [`live-validation-2026-07-21.md`](../live-validation-2026-07-21.md)。原始响应和复现脚本
  当时只暂存于 `/tmp`，诊断后已清理，因此这些结论虽然经过单变量复现，但当前仓库没有可
  重新校验的原始字节；这是证据保留缺口。
- **[CODE]**：当前实现实际接受、拒绝或投影的行为。它只说明“程序现在怎么做”，不证明
  5EPlay 协议保证如此。主要来源为
  [`data.ts`](../../packages/5eplay/src/protocol/data.ts)、
  [`events.ts`](../../packages/5eplay/src/details/events.ts)、
  [`load.ts`](../../packages/5eplay/src/details/load.ts) 和
  [`source.ts`](../../packages/5eplay/src/api/source.ts)。

文中的“已观察”只表示至少一个直接样本成立；除非明确写为多样本或完整链路，不代表上游
协议承诺或所有比赛都成立。“当前实现决策”和“未知”分别放在独立章节。

## 页面和数据入口

### 已观察事实

- 比赛详情页是 HTTP/MQTT 数据驱动的普通 React DOM。列表页和详情页均未发现 Canvas、
  WebGL、WebGPU、视频、iframe 或 SVG 特效目标；`web-shader-extractor` 对页面渲染本身在
  target-lock 阶段判定不适用。[OBS-20：`scout-card.json`、`known-gaps.md`]
- 详情 URL 的比赛标识形如 `csgo_mc_<正整数>`。详情页的主要权威快照来自
  `GET https://esports-data.5eplaycdn.com/v1/api/csgo/matches/{matchId}/data`。[OBS-20]
- `/data` 响应同时包含 `mc_info`、`tt_info`、`global_state`、`bouts_state` 和
  `state_ver`。已观察的 CS2 比赛在 `mc_info.match_version` 中使用 `cs2`。[OBS-20；FIX：
  `states/*.json`]
- 页面公开补充数据来自下列接口；它们不是核心比赛阶段的单一权威来源。[OBS-20]

  | 数据 | 已观察入口 |
  | --- | --- |
  | 赛前/对比分析 | `GET .../matches/{matchId}/analysis_v1` |
  | 全场或单图事件历史 | `GET .../match/{matchId}/event/log?update_version={cursor}&limit={limit}[&bout_id=...]` |
  | 页头近期比赛 | `GET .../teams/{teamId}/matches?page={page}&limit=20` |
  | 分析区历史比赛 | `GET .../team/matches_v1/{teamId}?page={page}&limit=30&status=past` |
  | 社区评分标签/卡片 | `GET https://app.5eplay.com/api/score/match_score_tab` 及 `match_score_list` |
  | 聊天室可用性 | `GET https://www.5eplay.com/api/im/has_match_chatroom`；登录态还有其他接口 |
  | 赛后内容 | `GET https://app.5eplay.com/api/tournament/content?...`，只在完赛后观察到 |

- 实时状态和事件分别使用 MQTT 主题 `csgo/product/detail/{matchId}` 与
  `csgo/product/event/log/{matchId}`。页面先向
  `POST https://www.5eplay.com/api/restrict/matchscore` 申请短期连接材料。[OBS-20；FIX：
  `mqtt/*.json`]
- `/data` 还包含直播配置、赔率百分比和额外预测主题等提供方字段，但页面没有订阅调查中
  探测到的预测主题。本项目需求明确排除 5EPlay 自身赔率、直播源、聊天和赛后内容；“上游
  存在”与“产品应采集”是两个不同事实。[OBS-20；当前需求]

### 当前实现决策

- 当前实现直接调用 JSON/MQTT 服务，不启动浏览器；核心只接受 `/data`，补充数据分成分析、
  两种战队历史、事件和社区评分五个独立 section。[CODE：`transport/http.ts`、
  `details/load.ts`]
- `snapshot()` 在补充数据收集前后各读一次 `/data`，只有核心语义 revision 未变化时才返回
  `confirmed`。可选 section 的失败不会自动把已确认核心状态改成猜测。[CODE：
  `api/source.ts`]

## 身份与跨源关联

### 已观察事实

- 比赛、赛事、战队和选手有各自 ID。实际样本包括 `csgo_mc_*` 比赛、`csgo_tt_*` 赛事、
  `csgo_tm_*` 或 `hltv_team_*` 战队，以及 `csgo_pl_*` 选手；因此战队 ID 不能硬编码为单一
  前缀。[OBS-20：`csgo_mc_2395755` 与 `csgo_mc_2395918` 原始响应]
- `/analysis_v1` 重复提供比赛、两队和赛事身份，可以与 `/data` 对账；两种历史接口中的每条
  比赛也包含可绑定到请求战队的身份。[OBS-20；FIX：`analysis/full.json`、
  `team-history/*.json`]
- 事件外层至少携带 `match_id`、`bout_num`、`bout_id`、`map_name`、`tt_id`、
  `update_version` 和 JSON 字符串 `log_info`。在正常历史样本中，`bout_id` 形如
  `{matchId}_{bout_num}`。[OBS-20；FIX：`events/page-*.json`]
- 同一地图的提供方名称并不唯一。2026-07-21 的一场 Ancient 在核心和普通事件中使用
  `Ancient`，但 `type=10` 的 match-started 事件使用 `de_ancient`；二者实际指向同一地图。
  [OBS-21：LIVE-002]
- 事件中的纯数字选手 ID 与核心中的 `csgo_pl_*` 可以指向同一选手命名空间；历史调查和
  当前最小 fixture 支持做显式规范化，而不是按显示名关联。[OBS-20；FIX：`events/*.json`]

### 当前实现决策与已知偏差

- 当前实现严格校验分析的比赛/两队/赛事身份、历史比赛的战队成员关系，以及事件的比赛、
  赛事、地图槽、`bout_id` 和地图名。[CODE：`details/analysis.ts`、`details/history.ts`、
  `details/events.ts`]
- 当前事件关联要求 `map_name` 字符串与核心完全相等，没有 engine name 到 display name 的
  canonicalization；`de_ancient` 因此会使整个事件 section 变成
  `EVENT_IDENTITY_OR_SCHEMA_MISMATCH`。[CODE；OBS-21：LIVE-002]
- 当前核心用“按 `bout_num` 排序后的槽号”直接充当领域 `mapNumber`。2026-07-21 已证明这个
  等同关系不总成立，见下一节。[CODE；OBS-21：LIVE-004]

## BO 格式、bout 槽位与实际比赛顺序

### 已观察事实

- 已完成连续验证的详情样本都是 `mc_info.format="3"` 的 BO3，并包含三个
  `bouts_state` 槽位。[OBS-20；FIX：`states/bo3-*.json`]
- `bout_num` 在正常 BO3 样本中为 1、2、3；事件的 `bout_num`/`bout_id` 也能关联这些槽位。
  这证明它是稳定的提供方槽位身份，但不能证明它永远等于实际开图先后顺序。[OBS-20]
- 2026-07-21 的 `csgo_mc_2396081` 出现
  `global=1, bouts=[-1,1,-1]`：`bout_num=1` 的 Ancient 未开，`bout_num=2` 的 Mirage 从
  round 1、`0:0` 继续到 round 2、`0:1`。Mirage 有完整 round-start/round-end 事件、第一回合
  恰好十次死亡和一致回合数组，而 Ancient 只有 match-started 事件。只交换两个
  `bout_num` 才能让现有分类器确认，交换数组位置无效。[OBS-21：LIVE-004]
- 因此，**提供方 bout 身份**和**证据推导的实际第几张图**是两个概念。至少存在“槽 2 实际
  先开”的真实比赛，不能仅按 `bout_num` 推断先后。[OBS-21：LIVE-004]
- 当前仓库的赛程模型能表示 `bestOf=1`，提供方详情格式码 `"1"` 也被识别为 BO1，但仓库
  没有两条独立、完整的真实 BO1 详情生命周期证据。[CODE：`protocol/data.ts`；FIX manifest
  中无 BO1 state trace]
- 2026-07-21 的真实赛程第 4 页出现过 `format="5"` 的未来总决赛。这只能证明发现层会遇到
  BO5，不能证明其详情槽位或状态语义。[赛程页事实](5eplay-schedule-page-facts.md#bo-格式)

### 未知

- BO1 的 `/data` 到底返回一个槽还是三个槽、终局向量、未使用槽形态、事件 `bout_id`、
  realtime 版本行为和关闭修订窗口均未验证。
- 非顺序开图是赛事配置、重赛、默认局重排还是常规 BP 结果尚不清楚；也不知道其发生频率，
  或分析/历史接口是否提供可靠的显式 chronological order。
- BO5 和其他格式没有详情事实基线；赛程发现层已经真实观察到 BO5，不能假设上游只出现
  BO1/BO3。

## 核心生命周期与地图状态

### 已观察的字段语义

- `global_state.status` 的已观察值：`0` 表示赛前，`1` 表示系列赛 LIVE，`2` 表示提供方已将
  系列赛标为结束。[OBS-20]
- `bouts_state[].status` 的已观察值：`-1` 表示该槽未开，`1` 表示进行中，`2` 表示该槽已
  结算或关闭。`2` **不单独证明这张图实际打过**。[OBS-20]
- `live_status` 在所有 2026-07-20 连续状态样本中始终为 `0`，不能区分赛前、图间、进行中
  或完赛。[OBS-20]
- `plan_ts` 会改期、越过而比赛仍未开始；它只能作为计划时间，不能判定实际阶段。[OBS-20]
- BP/地图名称填入、倒计时归零和热身事件均可能早于正式开图，不能代替核心状态。[OBS-20；
  OBS-21：LIVE-005]

### 正常 BO3 状态链

同一场 `csgo_mc_2395547` 在 2026-07-20 完整经历了下列链，因而这些组合都有同场、同源的
直接证据：[OBS-20；FIX：对应 `states/bo3-*.json`]

| `global / bout statuses` | 人眼和数据状态 |
| --- | --- |
| `0 / -1,-1,-1` | 比赛未开始 |
| `1 / -1,-1,-1` | 系列赛已开始，实际图 1 尚未开始 |
| `1 / 1,-1,-1` | 图 1 进行中 |
| `1 / 2,-1,-1` | 图 1 结束，图 2 尚未开始 |
| `1 / 2,1,-1` | 图 2 进行中 |
| `1 / 2,2,-1` | 图 2 结束，图 3 尚未开始 |
| `1 / 2,2,1` | 图 3 进行中 |
| `2 / 2,2,2` | 三图打满后系列赛结束 |

- `global=2, [2,2,-1]` 是已观察的正常 2:0 结束形态；未使用的图 3 仍保持 `-1`，不能伪造
  图 3 结束时间。[OBS-20：`csgo_mc_2396047`、`csgo_mc_2395755`]
- `global=1, [2,2,-1]` 与上述 2:0 形态不同：前者确实曾持续约 14 分 26 秒，表示 1:1 后
  等待图 3。[OBS-20：`csgo_mc_2395547`]

### 已观察的非正常边界

- 在任何地图正式开始前，`global` 可以从 `1` 回退到 `0`，计划时间同时后移，之后又重新
  进入 `1`。该回退没有对应 MQTT 消息，已打开页面保持错误的 LIVE，刷新 HTTP 后才恢复
  赛前。[OBS-20：`csgo_mc_2395920`]
- 地图切换处会出现全零 `from_ver` 的状态包，它可能包含完整地图对象，但不属于普通非零
  增量版本链；后续普通包可能继续使用全零包之前的非零游标。[OBS-20；FIX：
  `mqtt/detail-zero.json`、`mqtt/detail-gap.json`]
- `csgo-detail-bp` 既可能在 `global=0`、仅地图 BP 变化时出现，也可能携带 `global=1`；它
  只能证明需要重拉 HTTP，不能单独证明比赛开始。[OBS-20；FIX：`mqtt/detail-bp.json`]
- 曾捕获 `global=2` 但最后一张实际地图仍为 `status=1, 12:7` 的短暂 HTTP 快照；约 8 秒后
  才修订为地图 `status=2, 13:7`。矛盾窗口不能向外确认完赛。[OBS-20：
  `csgo_mc_2396047`]
- 技术结果样本从 `global=1, [2,-1,-1]` 跳到 `global=2, [2,2,2]`：图 2 被记为 `1:0` 但
  没有开始/结束时间，图 3 为 `status=2` 却没有比分、结果或时间。页面显示系列赛 2:0。
  因此 `bout.status=2` 表示“槽位结算/关闭”，实际打过还必须结合时间、比分、结果、回合和
  事件。[OBS-20：`csgo_mc_2395920`；FIX：`states/technical-settlement.json`]
- 2026-07-21 还观察到前述 `1 / -1,1,-1` 非顺序正式开图。它不应被简单归类为瞬时矛盾，
  但其 chronological map number 需要跨源证据推导。[OBS-21：LIVE-004]

### “比赛关闭”的事实边界

- 上游已观察到的明确终局信号是 `global_state.status=2`；没有观察到区别“刚结束”和“最终
  不再修订”的另一个 provider status。[OBS-20]
- 终局首报仍可能修订。`csgo_mc_2395547` 的后续 HTTP 把 Mirage `start_time` 从
  `1784550794` 改为 `1784550834`，`end_time` 从 `1784553565` 改为 `1784553564`。[OBS-20]
- 因此当前公开模型中的 `closing/provisional` 与 `closed/stable` 是采集器的稳定性结论，不是
  5EPlay 原生两个状态。当前默认在终局地图结束至少三分钟后，再要求相隔至少一个 live poll
  的两份一致 HTTP 才提升为 closed。[CODE：`api/source.ts`]

## 比分、半场、回合和加时

### 已观察事实

- 系列赛比分位于 `global_state.t1_score/t2_score`；每图双方有 `all_score`、`quick_score`、
  `fh_score`、`sh_score`、`ot_score`，以及对应 `fh_data/sh_data/ot_data` 回合代码数组和
  `fh_role/sh_role/ot_role` 阵营。[OBS-20：真实 `/data`；FIX：`states/*.json`]
- 常规结束样本满足 `all_score = fh_score + sh_score`；加时样本满足
  `all_score = fh_score + sh_score + ot_score`。这是样本一致性，不是上游正式规范。[OBS-20：
  `csgo_mc_2395755`]
- CS2 样本的 `round_num="12"`，`curr_bout_stage` 已观察到 `fh`、`sh` 和 `ot`。一场 Dust2
  以 `16:14` 结束，双方分别为 `4+8+4` 与 `8+4+2`，且 `ot_data` 各有 6 个回合代码，证明
  加时不能按固定最多 24 回合建模。[OBS-20：`csgo_mc_2395755`]
- `curr_round_num`、`round_start_time`、`game_time` 和 `bomb_planted_time` 在进行中地图可用，
  但部分时间字段会为空；空值不能自动代表该阶段没有发生。[OBS-20；FIX：state fixtures]
- 2026-07-21 证明 `quick_score` 在未结算回合中可以领先 `all_score`：正式分从 `2:1` 到
  `3:1` 时，quick 分依次出现 `3:1`、`4:1`、`5:1`。它是回合内的临时/前瞻比分，不是
  必须与已结算总分相等的副本。[OBS-21：LIVE-001]
- 该差异会持续整个回合，不只是毫秒级切换；半场切换的短暂相等窗口并不能证明严格相等规则
  正确。[OBS-21：LIVE-001]

### 当前实现已知偏差

- 当前实现要求每队 `quickScore === score === firstHalf + secondHalf + overtime`，导致合法的
  进行中回合被整体返回 `blocked/inconsistent-state`。[CODE：`protocol/data.ts` 的
  `assertActiveTeamScore`；OBS-21：LIVE-001]
- 当前代码只把 `fh/sh` 映射为 first/second half；`curr_bout_stage=ot` 会变成 `null`，随后又
  因 live/settled map 要求非空 stage 而被拒绝。虽然模型保存了 `ot` 比分、阵营和数组，当前
  核心 decoder 仍不能确认真实加时阶段。这是实现与历史真实样本之间的已知缺口，不是上游
  不支持加时。[CODE：`protocol/data.ts` 654–656、746–757、847–861；OBS-20：
  `csgo_mc_2395755`]

### 未知

- `fh_data/sh_data/ot_data` 中每个数字代码的完整枚举语义尚未形成一手事实表。
- `quick_score` 在回合取消、重开、加时切半和技术暂停时如何回退或修订尚未验证。
- 多次加时、非 MR12 赛事规则和不同赛事插件的字段形态尚未完整覆盖。

## 玩家实时状态和统计

### 已观察事实

- `/data` 同时提供系列赛级 `global_state.t*_player_stats` 和每图
  `bouts_state[].t*_pr_stats`。实际行包含身份、名称、K/D/A、ADR、rating、KAST、impact、
  首杀/首死、爆头、多杀、残局、经济、血量、防具、拆弹器、武器和图片等字段的不同子集。
  [OBS-20；FIX：`statistics/*.json`]
- 正常终局样本存在 `overall` 行而 CT/T 分拆可能为空；技术终局样本反而出现 overall 为空、
  CT/T 有数据。任一平面缺失都不能用另一平面推造。[OBS-20；FIX manifest：
  `statistics/normal-terminal.json`、`technical-terminal.json`]
- 提供方出现过 `NaN%` 百分比哨兵，只能解释为该字段未知，不能使整名选手或整场比赛失效。
  [OBS-20；FIX：statistics fixtures]
- opponent duel 数据同时有列表和 map 两种表达；真实样本中存在 map 有值而列表为空的 MVP
  形态。[OBS-20；FIX：statistics fixtures]
- 2026-07-21 一场刚进入 `map1-live`、仍为 round 1 和 `0:0` 的比赛已经返回一名选手 25 kills、
  多人 12 deaths、最高 56,300 金钱和合计 77 deaths。随后 37 秒内比分和 round 不变，合计
  deaths 从 114 增至 132、kills 从 107 增至 123；十个 ID 又都与分析阵容相符。这是会重生的
  热身统计，不是身份串场。[OBS-21：LIVE-003]

### 当前实现已知偏差

- 当前实现检查数字形态、团队/选手身份唯一性和 duel 对手归属，但没有把统计与
  `currentRound`、已结算回合数组、正式比分和 CS2 非重生规则做时间一致性校验；因此上述热身
  数据被标为 `present`。[CODE：`protocol/data.ts`；OBS-21：LIVE-003]
- 公开数据必须把 `present/empty/unavailable` 分开；“字段不存在或 schema 不支持”不是合法空
  数组。这是当前模型中值得保留的防误用决策。[CODE：`domain/model.ts`]

### 未知

- 上游没有在已留存的异常样本中提供可靠 warmup flag；正式统计从何时清零、是否总会清零、
  stand-in/换人和断线重连如何反映，仍需新的完整抓包。
- 玩家统计与事件历史的最终一致性、修订时延和暂停/重赛时的计数回滚尚未系统验证。

## 事件时间线

### 已观察事实

- 事件 HTTP 页面按 `info.update_version` 从新到旧返回。下一页以当前页最旧事件的
  `update_version` 为 cursor；实测下一页更旧且不重复 cursor 行。[OBS-20]
- `not_more="1"` 在确有更旧数据时也出现过，不能作为完整历史的终止条件。空页、短页或 cursor
  不再前进才是已验证的安全停止信号，且必须按事件身份去重。[OBS-20]
- `log_info` 是 JSON 字符串。已观察类型至少包括 `1` round start、`2` round end、`3` player
  join、`4` player quit、`6` bomb planted、`8` kill、`10` match started；其他键如 assist、
  suicide、bomb defused 也可出现在信封中，但完整类型枚举未验证。[OBS-20；FIX：
  `events/*.json`；OBS-21：LIVE-005]
- 热身事件会在 `global=1` 且所有 bout 仍 `-1` 时活跃，因此“有击杀/有日志”不能证明地图
  正式开始。[OBS-20]
- 2026-07-21 的 `map1-unopened` 响应中有 84 条事件：56 kills、26 quits、1 join、1 match
  started，没有 type 1/2 的正式 round start/end，也没有可用 warmup flag、timestamp 或
  round number。kill 行仍有双方 ID、阵营、武器、坐标和证据引用，外形上无法与正式击杀区分。
  [OBS-21：LIVE-005]
- 同一批事件还包含 `de_ancient`/`Ancient` 别名冲突。[OBS-21：LIVE-002]
- MQTT 事件是低延迟追加信号，不证明 HTTP 全历史已完整；重连、地图结束和完赛时仍需 HTTP
  回填。[OBS-20]

### 当前实现已知偏差

- 当前事件加载器能处理并发新增的 head：回填旧尾后重读 cursor 0，必要时桥接到已收集历史，
  并对重复 identity 比较 fingerprint。这是当前一致性算法，不是 provider 保证。[CODE：
  `details/events.ts`]
- 当前实现的“complete”只证明 transport 分页头尾稳定，却没有与核心阶段或正式 round
  boundary 交叉验证；所以 84 条热身日志会被错误声明为完整比赛历史。[CODE；OBS-21：
  LIVE-005]
- 当前类型模型没有 `warmup/provisional/official` 维度。修复地图别名后仍会把 warmup kill
  当普通 `type="8"` 输出，因此 LIVE-002 和 LIVE-005 是两个独立问题。[CODE；OBS-21]

### 未知

- 所有 event type、嵌套字段、删除/修订语义、timestamp 单位和每种边界的 round number
  可靠性仍未穷举。
- 官方比赛与热身的可靠分界应取哪组证据仍未知；现有异常样本只证明“不能靠事件存在、地图名
  或选手身份”，没有证明某个单字段足够。
- 非顺序开图时，事件 `bout_num` 到 chronological map number 的长期稳定映射仍需验证。

## 分析、历史、veto 和社区数据

### 已观察事实

- `/analysis_v1` 提供：双方选手/队伍统计、地图 pick/ban 使用率和胜率、player power 多级
  指标、两队近期比赛、交手记录及赛事/阶段身份。[OBS-20；FIX：`analysis/full.json`]
- `/teams/{id}/matches` 与 `/team/matches_v1/{id}` 是不同数据产品：前者按赛事组织页头近期
  比赛，后者提供分析区过去比赛、总页数/总行数、胜率和连胜等。不能将二者当同一响应的两个
  URL 别名。[OBS-20；FIX：`team-history/*.json`]
- veto 在核心 `global_state.bp_map_item` 中表现为按顺序的 `ban/pick/left`、地图和操作方；每图
  还有 `bp_act`。严格样本曾完整出现两 ban、两 pick、两 ban、最后 left 的七步 BO3 BP。
  [OBS-20：`csgo_mc_2395547` 完赛 `/data`]
- 地图 BP 和地图名称可以先于 `global=1` 出现，不能用 veto 完成推断比赛已经开打。[OBS-20]
- 社区评分接口有“请求成功但空”的真实样本；空数据与接口失败必须分开。[OBS-20；FIX：
  `community/tabs-empty.json`]

### 当前范围

- 当前需求包含分析、两种历史、veto 和社区评分，但排除 5EPlay 赔率、直播、聊天室和赛后内容。
  当前实现与此范围一致；此处不因为上游页面展示而扩大采集范围。[CODE；当前需求]

### 未知

- 分析数据在开赛后是否冻结、如何修订，以及地图/选手样本时间窗的所有 provider code 尚未
  建立事实表。
- 两种历史接口在超长分页、重复赛事分组和比赛状态回滚时的完整性尚未做真实长链验证。

## HTTP、MQTT 与页面一致性

### 已观察事实

- 页面源码按 `bout_num-1` 替换 MQTT 传入地图对象，对 `global_state` 做浅合并，验证状态消息
  的比赛 ID 和事件消息的比赛 ID，并忽略状态增量中的两项赔率百分比。[OBS-20：路由实际
  加载 bundle]
- 普通非零版本通常形成 `next.from_ver == previous.this_ver` 的链，但全零 `from_ver` 是并行
  baseline/reset 分支，不能推进普通游标。[OBS-20；FIX：MQTT fixtures]
- 页面不处理 `csgo-detail-bp`，并且比赛未开图前的 `1 -> 0` 回滚没有 MQTT 消息；已打开页面
  因此多次显示过时状态，刷新 HTTP 后才正确。[OBS-20]
- 地图结束时间和终局开始/结束时间都出现过后续 HTTP 微调，说明 MQTT 或第一份 HTTP 不应
  被永久冻结为最终值。[OBS-20]
- 2026-07-21 的 real `watch()` 基线成功经历 `blocked/initializing -> confirmed-state/
  map1-unopened` 并干净退出；这只证明该样本初始化正常，不证明所有实时边界正确。[OBS-21]

### 当前实现决策

- 当前 watcher 先取得 state topic SUBACK 并缓冲消息，再拉 HTTP baseline；MQTT 只能触发
  provisional telemetry 或 HTTP resync，不能单独推进公开 confirmed 状态。[CODE：
  `sync/watch.ts`、`transport/mqtt.ts`]
- 身份不符、版本断链、全零分支、`csgo-detail-bp`、重连或解析矛盾都会触发 HTTP 对账；live
  默认每 5 秒轮询，赛前按远近使用 60/10 秒。[CODE：`api/source.ts`、`sync/watch.ts`]

## 各阶段可获得数据的事实边界

下表描述已观察的“可能出现”，不是保证每场都有。可选 section 仍需自己的 completeness/gap。

| 阶段 | 已观察到的数据 | 必须防止的误读 | 证据 |
| --- | --- | --- | --- |
| 赛前 `global=0` | 比赛/队伍/赛事/计划时间、分析、历史；BP 和地图可能尚空 | `plan_ts` 越时、BP 或热身日志不等于开赛 | [OBS-20] |
| LIVE、实际首图未开 | `global=1`、地图/BP、系列分 `0:0`、热身事件可能大量出现 | 热身击杀和选手计数不是正式数据 | [OBS-20；OBS-21] |
| 地图进行中 | 当前回合/阶段/阵营、正式比分、quick 分、经济装备、玩家行和事件 | quick 分可能领先；开图初期 player/event 仍可能混入热身 | [OBS-20；OBS-21] |
| 图间 | 前图结果、终局统计和末回合事件；下一槽未开 | 不能用日志是否仍活跃判断下一图 | [OBS-20] |
| 系列赛刚结束 | 系列结果、已打图最终数据、未使用/技术槽位 | `status=2` 不等于每槽实际打过；首报仍可修订 | [OBS-20] |
| 采集器 stable closed | 与终局相同，但经过本地稳定窗口 | 这是本地 finality，不是新 provider status | [CODE] |

无论阶段，补充接口可能合法为空、部分完成、超限、schema 不支持或暂时失败；成功的空数组和
无法取得必须是不同状态。[CODE；FIX：community empty 与 section fixtures]

## 2026-07-21 新事实与现有基线的修订

| ID | 新事实 | 推翻或收紧的旧假设 | 证据状态 |
| --- | --- | --- | --- |
| LIVE-001 | `quick_score` 是未结算回合内的前瞻分，可长期领先 `all_score` | quick 必须等于正式分 | 确定性单变量复现；原始字节未保留 [OBS-21] |
| LIVE-002 | 同图可同时出现 `de_ancient` 与 `Ancient` | map name 可做严格字符串 identity | 确定性单变量复现；原始字节未保留 [OBS-21] |
| LIVE-003 | 正式图刚开时 provider player planes 可继续承载热身累计 | 阵容 ID 正确即可把统计标为 present | 连续增长和单变量复现；原始字节未保留 [OBS-21] |
| LIVE-004 | `bout_num=2` 可先发生有完整正式证据的实际首图 | provider bout number 永远等于 chronological map number | 回合、比分、十次死亡、事件和 bout-number 交换实验一致；原始字节未保留 [OBS-21] |
| LIVE-005 | 未开图阶段可有大量无 warmup 标记的 kill/join/quit，稳定分页仍不代表正式历史完整 | transport complete 等于 semantic complete | 84 行类型计数和单变量复现；原始字节未保留 [OBS-21] |

这些发现不应简单追加为五个例外。它们共同说明核心状态、比分、玩家和事件是不同时间语义的
数据平面：身份一致和传输完整只是必要条件，不足以证明内容属于同一条正式比赛时间线。

## 当前实现假设/决策清单

下列项目是代码现状，不能写进“提供方协议事实”：

1. 只确认 BO3；BO1 返回 `unsupported/format-unverified`。[CODE]
2. `bout_num` 被直接当 chronological `mapNumber`。[CODE；已被 LIVE-004 反例否定]
3. 只接受固定正常 BO3 状态向量及一个技术终局形态。[CODE]
4. `quickScore` 必须等于正式总分。[CODE；已被 LIVE-001 反例否定]
5. 玩家 plane 只做 schema/identity 校验，不做时间合理性校验。[CODE；LIVE-003]
6. 事件地图名严格相等，分页稳定即可 `complete`。[CODE；LIVE-002、LIVE-005]
7. `closed/stable` 由本地三分钟 calibration 和双 HTTP 一致性推导。[CODE]
8. 可选 detail section 独立表达 `complete/empty/partial/unavailable/not-applicable`。[CODE]
9. odds、streams、chat、post-match editorial 被显式排除。[CODE；当前需求]

重构时应逐项决定：保留为产品策略、改为证据驱动规则，还是在事实不足时继续明确返回 unknown；
不应通过放宽所有校验来掩盖反例。

## 仍待真实验证的问题

以下均为未知，不能当成“没有问题”或用 synthetic fixture 补成事实：

1. 两条独立 BO1 从赛前、实际首图未开、进行中、结束到稳定关闭的完整 HTTP/MQTT/事件链。
2. BO1 的槽位数、终局向量、技术判定和未使用槽表达。
3. 非顺序 bout 的成因、频率，以及 provider bout identity 到实际图序的可靠映射证据。
4. 正式回合开始前后，玩家统计和事件从 warmup 切换的可靠边界。
5. `quick_score` 在暂停、回合重开/取消、加时切换和数据回滚中的完整行为。
6. 所有回合代码、event type 和 map engine/display alias 的枚举。
7. 多次加时、不同赛制插件、弃权、取消、延期、重赛、换图和换人。
8. `global=2` 后最长修订窗口，以及提供方是否存在比本地三分钟更可靠的最终性信号。
9. `not-found` 是永久不存在、暂时未生成、下线还是关闭后的删除；当前无事实区分。
10. 赛事 `start_time/end_time` 字符串的可靠时区；证据不足时只能保留 provider-local。
11. 两种战队历史的真实长分页稳定性，以及分析数据在开赛/完赛后的修订规则。

## 长期证据维护约定

- 本文和赛程页事实文档保存“可复用事实”；临时探索目录、浏览器 profile、bundle、DOM、截图和
  大量重复轮询响应不回到当前工作树。
- 新事实至少记录：页面/接口、比赛 ID、UTC 时间、原始状态向量、关键字段、单变量实验、预期与
  实际、证据哈希和可复现命令。涉及跨阶段语义时优先保留一条完整时间链，而非只留单帧。
- 可公开且不敏感的最小响应应脱敏后进入 `packages/5eplay/tests/fixtures/`，在 manifest 中记录
  `kind`、原始 label、capture time、原始/裁剪 SHA-256 和 derivation；不要把真实数据改写成
  `real` fixture。
- 高容量原始抓包可放在仓库外的受控证据存储，但必须留下内容哈希和稳定定位；短期凭据、cookie、
  会话和账号材料永不持久化。
- 每次实现与事实冲突时，先更新本文的已观察事实和未知项，再修改协议规则与测试。实现文档只
  引用此事实基线，不重复维护另一套“现实真相”。
