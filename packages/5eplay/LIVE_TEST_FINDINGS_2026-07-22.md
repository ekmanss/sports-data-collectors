# 5EPlay 真实比赛快照审计（2026-07-22）

## 结论

原始审计阶段只测试、记录问题，没有修改实现代码。测试达到预设停止条件后停止：覆盖常见比赛状态，且累计至少 10 个可复现的独立问题。后续已按本报告实施修复；下面的问题描述保留修复前证据，便于追溯。

原始审计中最需要优先处理的是比赛日志可信度：修复前“部分数据”可能包含热身、重复甚至与本场阵容无关的事件，仍被输出为“正式事件”；这会直接误导 AI 对击杀、回合和选手表现的分析。

## 修复与回验（2026-07-22 12:05–12:10 UTC）

F01–F16 均已处理，并补充确定性回归测试。主要结果：

|问题|修复结果|
|---|---|
|F01、F06|partial/unavailable 日志在 MD 中显示精确 `gap`，但不再输出事件明细；完整原始 JSON 仍保留。`2396055` 的新 MD 从修复前 93,432 bytes 降至 35,024 bytes，且不含污染日志表。|
|F02、F04|正式回合按 `round_end` 累计比分重建；同一累计比分采用最后一个候选，过滤刀局比分重置；缺失 `round_start` 时仍可恢复回合。`2396064` 第一图 R1 已只剩正式手枪局，`2395928` 的 R3 已恢复。|
|F03|有 `event_id` 时按 match/bout/type/event ID 去重，忽略等价重发的 `updateVersion`；无稳定 ID 时才回退版本键。`2395928` 的 240 个稳定 ID 和 `2396064` 的 612 个稳定 ID 均无重复。|
|F05|事件页改为逐行隔离。`2396053` 现保留 694 条通过身份校验的事件并标记 partial；MD 因不完整而不渲染明细。|
|F07|完整且唯一可连接的 BP 选图顺序可用于确定地图顺序；终局允许技术判胜位于任意已完成地图位置。`2396081` 现 confirmed/closed/administrative，地图依次为 Ancient 1:0 技术判胜、Mirage 13:16、Dust2 13:11。|
|F08|`blocked / inconsistent-state` 结果新增机器可读 `diagnosticCode`。|
|F09|CLI 对 blocked/unsupported/not-found/superseded 输出单行 JSON 和不同退出码，不再主动抛出 Node 调用栈；pnpm 外层仍会显示其标准生命周期失败摘要。|
|F10、F11|未确定 BP 统一显示 `—`，不再出现字面量 `null` 或动作 `unknown`。|
|F12、F13|晚于快照的 live 时间被忽略并标记，零值回合计时不再输出。|
|F14、F15|MD 展示值统一去除首尾空白；日志和装备列共用扩展后的标准武器名称表。|
|F16|TBD 的已知 BO3 返回 `unsupported / participants-unresolved / format=3`。已用 `2396065` 的实时响应回验。|

验证结果：package 类型检查通过；101 个测试全部通过；package 构建通过；`git diff --check` 通过。真实复验产物位于 `/tmp/5eplay-fix-verify.06ZzKS`，不应提交到仓库。

## 测试范围

- 数据时间：2026-07-22 11:39–11:48 UTC。
- 从 5E 赛程接口读取前 5 页，共检查 100 条 live/upcoming 赛程记录。
- 实际执行 17 次 `snapshot`：13 次 confirmed，4 次返回非 confirmed 结果。
- confirmed 状态覆盖：
  - 比赛未开始：5 场；
  - 图 1 进行中：3 场；
  - 图 2 进行中：3 场；
  - 两图结束的稳定终局：1 场；
  - 三图结束的稳定终局：1 场。
- 另外检查：TBD 参赛方、BO5、首图技术判定后打满三图的终局。
- 未在本轮真实时间窗口捕获：图 1 未开但比赛已开始、图 1/2 之间、图 2/3 之间、图 3 进行中、closing/provisional。它们是瞬态状态，仍需后续专门守候测试。

主要样本：

|状态/边界|比赛 ID|结果|
|---|---|---|
|比赛未开始|`csgo_mc_2396003`、`csgo_mc_2396054`、`csgo_mc_2396059`|confirmed|
|图 1 进行中|`csgo_mc_2395928`、`csgo_mc_2396086`、`csgo_mc_2395551`|confirmed|
|图 2 进行中|`csgo_mc_2395999`、`csgo_mc_2396053`、`csgo_mc_2396064`|confirmed，其中 `2396053` 日志 unavailable|
|两图稳定结束|`csgo_mc_2396085`|confirmed|
|三图稳定结束|`csgo_mc_2396055`|confirmed，但日志 partial 且严重污染|
|首图技术判定后 2:1 结束|`csgo_mc_2396081`|blocked / inconsistent-state|
|TBD 参赛方|`csgo_mc_2396065`、`csgo_mc_2395552`|unsupported / provider-schema-unsupported|
|BO5|`csgo_mc_2395553`|unsupported / format-not-supported（已知限制）|

测试产物临时保存在 `/tmp/5eplay-live-audit.mSH4C1`，不应提交到仓库。

## 问题记录

### F01 · P0 · partial 比赛日志会输出大规模污染事件

- 样本：[`csgo_mc_2396055`](https://event.5eplay.com/csgo/matches/csgo_mc_2396055)。
- JSON：`details.events.status=partial`、`gap=EVENT_IDENTITY_OR_SCHEMA_MISMATCH`，但仍保留 2,500 条事件。
- 生成的 MD 为 93,432 bytes；单个 R2 中出现数百条击杀，包含 `sausoL`、`mopoz`、`CRUC1AL` 等不属于本场 Astralis/FOKUS 阵容的选手。
- 影响：AI 会把非本场事件当成正式比赛数据，击杀、选手和回合分析都不可信。
- 建议：输出前必须按本场阵容、地图、回合比分连续性验证；未通过时整段隔离，不能以“部分数据”继续渲染为正式日志。

### F02 · P0 · 热身刀战被当作正式回合

- 样本：[`csgo_mc_2396064`](https://event.5eplay.com/csgo/matches/csgo_mc_2396064)，第二图 Ancient。
- MD 的 R1 先出现多条同阵营刀杀和 `CT 0:1 T`，随后同一 R1 又出现正式手枪局并结束为 `CT 1:0 T`。
- R2 也先出现一个结束比分 `1:0`，随后才结束为 `2:0`。
- 影响：违反“只保留正式回合”的要求，并使单回合出现两次互相冲突的最终比分。
- 建议：不能仅凭 `round_start` 判定正式回合；还应验证比分从 0:0 单调递增、每回合只允许一个结束事件，并排除同阵营大规模刀杀阶段。

### F03 · P0 · 同一事件 ID 的重发没有去重

- 样本：`csgo_mc_2395928`。
- 事件 ID `3913770126`、`3913770141`、`3913770149` 各出现两次：`updateVersion` 不同，但 `evidenceRef` 和事件内容相同。
- MD 的 R4 因此重复输出三条击杀。
- `csgo_mc_2396064` 还检测到 41 组重复击杀事件 ID。
- 原因线索：当前事件键使用 `matchId + providerBoutId + updateVersion`，没有优先使用稳定的 `event_id` 或相同 `evidenceRef` 去重。

### F04 · P1 · 缺少 round_start 时整回合正式事件丢失

- 样本：`csgo_mc_2395928`。
- 上游序列为：R2 结束 `1:1` → 没有 R3 `round_start` → R3 结束 `1:2` → R4 `round_start`。
- MD 从 R2 直接跳到 R4，R3 的击杀、下包和回合结束均未输出。
- 影响：日志声称“完整”，实际缺失一个正式回合。
- 建议：可用 `round_end` 的比分增量恢复缺失的回合边界；若无法恢复，应把 section 标为 partial 并明确缺失范围。

### F05 · P1 · 一条事件身份冲突会让整页、乃至全部日志不可用

- 样本：`csgo_mc_2396053`。
- 核心数据中 provider bout 3 是未开始的 Nuke；事件接口头部却返回 `bout_num=3 / Ancient`。
- 当前整页 `rows.map(...)` 任一行抛错即失败，结果为 `events.status=unavailable`，已完成图 1 和进行中图 2 的所有合法日志一起丢失。
- 建议：逐行隔离错误并保留可验证事件，同时将 section 标为 partial、记录被隔离数量和原因。

### F06 · P1 · MD 隐藏日志 gap，AI 无法判断“不可用/部分数据”的原因和风险

- `csgo_mc_2396053` 的 JSON 明确记录 `EVENT_IDENTITY_OR_SCHEMA_MISMATCH`，MD 只显示“采集状态：不可用”。
- `csgo_mc_2396055` 只显示“采集状态：部分数据”，却继续输出严重污染的日志。
- 影响：AI 既不知道缺口原因，也无法区分“分页少量缺失”和“身份验证失败、数据不可信”。
- 建议：保留面向分析的简短原因，例如“身份/地图校验失败；本节不可用于统计”。

### F07 · P1 · 首图技术判定、后两图正常完成的 2:1 终局被拒绝

- 样本：[`csgo_mc_2396081`](https://event.5eplay.com/csgo/matches/csgo_mc_2396081)。
- 5E 页面正常显示 Mai Tai 2:1 eternal premium：第一图 Ancient 1:0，第二图 Mirage 13:16，第三图 Dust2 13:11。
- 核心接口中第一图 `status=2/result=t1`，但没有开始、结束时间和回合比分；后两图正常打完。
- `decodeCoreResponse` 连续 3 次抛出 `terminal map layout is not evidence-backed`，公共 API 转为 `blocked / inconsistent-state`。
- 影响：合法且页面可见的三图比赛无法生成 JSON/MD。

### F08 · P1 · public result 丢失 inconsistent-state 的具体不变量

- `csgo_mc_2396081` 内部可定位为 `terminal map layout is not evidence-backed`，但 `snapshot()` 只返回通用 `reason=inconsistent-state`。
- 影响：手动排错必须导入内部解析器或检查源码，JSON 结果和 CLI 都无法说明是哪项校验失败。
- 建议：保留稳定、非敏感的诊断码，例如 `TERMINAL_LAYOUT_UNSUPPORTED`，不必暴露原始上游内容。

### F09 · P2 · snapshot CLI 把预期的结果联合类型当异常抛出

- blocked、unsupported、not-found 都会由 `tools/snapshot.ts` 抛 `Error`，打印源码位置和 Node 栈。
- 本轮在 TBD、BO5、技术判定终局上均复现。
- 影响：人工使用体验差，脚本调用也只能解析 stderr 文本。
- 建议：stderr 输出简洁结构化结果并使用可区分 exit code；只有真正未处理异常才打印栈。

### F10 · P2 · 未完成 BP 时输出字面量 `null`

- 样本：`csgo_mc_2396003`、`csgo_mc_2396054`、`csgo_mc_2396059`、`csgo_mc_2395991`、`csgo_mc_2396066`。
- 三个未开地图均显示 `本场 BP：null`。
- 预期：`—`、`尚未确定`，或在无 BP 时省略该行。

### F11 · P2 · 同一份赛前 MD 同时说“暂无 BP”和每张图 `unknown`

- 上述未开始比赛的 `地图BP` 章节显示“暂无数据”。
- `地图分析` 表的“本场BP”列却为每张图输出英文 `unknown`。
- 影响：`unknown` 容易被理解为一种实际 BP 动作，且与“暂无数据”自相矛盾。

### F12 · P2 · 当前回合开始时间晚于快照时间

- 6 个 live 样本中有 5 个提供非空 `roundStartedAt`，它们全部晚于 `observedAt`，偏差约 +10.248 到 +99.987 秒；另 1 个为空。
- MD 直接标为“当前回合开始（UTC）”，没有提示上游时钟或遥测异常。
- 建议：校验未来时间；异常值置为不可用或明确标记“接口遥测，时钟未校准”。

### F13 · P2 · 6/6 live 样本的“回合计时（秒）”均为 0

- 当前输出无法区分真实倒计时到 0、未初始化和固定占位值。
- 结合未来的 `roundStartedAt`，该字段不适合直接用于 AI 时序判断。
- 建议：明确计时方向和口径；确认 0 为占位时省略。

### F14 · P2 · 名称前后空白未规范化

- 样本：`csgo_mc_2395991`、`csgo_mc_2396066`。
- 上游队名为 ` 3DMAX`，MD 出现 `#  3DMAX vs magic`、`Walczaki vs  3DMAX` 和 `####  3DMAX`。
- 历史赛事名、阶段和地点中也检测到同类首尾空白。
- 影响：标题不专业，也会妨碍名称去重和 AI 实体匹配。

### F15 · P2 · 武器/装备仍大量保留引擎 ID

- 已规范化部分武器，但真实日志和装备列仍出现 `m4a1`、`m4a1_silencer`、`deagle`、`famas`、`mp7`、`hegrenade`、`knife_butterfly`、`knife_gut`、`knife_karambit` 等。
- 预期示例：M4A4、M4A1-S、Desert Eagle、FAMAS、MP7、HE Grenade、Butterfly Knife。
- 影响：同一武器有多种写法，降低 AI 聚合统计质量。

### F16 · P2 · TBD 比赛错误信息丢失已知赛制

- 赛程接口明确 `csgo_mc_2396065` 和 `csgo_mc_2395552` 为 BO3；前者双方 TBD，后者一方 TBD。
- `snapshot()` 返回 `provider-schema-unsupported / format=null`。
- 影响：调用者无法区分“参赛方尚未确定”和“未知 schema/未知赛制”。
- 建议：返回专门的 unresolved-participants 状态，至少保留赛程已知的 BO3 信息。

## 已知限制，不计为新缺陷

- `csgo_mc_2395553` 为 BO5，当前返回 `format-not-supported`；README 已明确只支持当前证据充分的 BO3，因此本轮只记录覆盖结果，不列为回归。

## 建议修复顺序

1. 先停止输出未通过阵容、地图、回合和比分连续性验证的事件；partial 不能等同于可信子集。
2. 用稳定 `event_id`/`evidenceRef` 去重，并建立正式回合状态机：比分单调、每回合一个 round_end、允许从比分恢复缺失 round_start。
3. 支持首图技术判定后继续正常比赛的终局布局，并把具体诊断码透传到 public result/CLI。
4. 最后处理 MD 表述与规范化：`null`/`unknown`、时间遥测、0 计时、名称空白、武器名称。

## 后续测试建议

修复前不建议继续扩大样本量，因为当前日志污染已经使更多采样的边际价值很低。修复后再守候真实比赛转换，重点捕获：map-unopened、between-maps 1→2、between-maps 2→3、map 3 live 和 closing；每种状态至少保留两个独立样本，并验证 JSON 与 MD 的状态专属字段。
