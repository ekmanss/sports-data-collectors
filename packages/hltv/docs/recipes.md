# 手动操作指南

本文提供可直接复制执行的命令，用于单次手动采集 HLTV 数据。所有命令都从仓库根目录运行，并将临时结果写入 `outputs/`；该目录已被 Git 忽略。

运行示例前，先构建本地包并创建输出目录：

```bash
pnpm --filter @ekmanss/hltv build
mkdir -p outputs
```

如果是在其他项目中使用，请先安装 `@ekmanss/hltv`，并将示例中的 `./packages/hltv/dist/index.js` 替换为 `@ekmanss/hltv`。

## 获取进行中的比赛列表

保存完整返回结果，包括业务数据 `data` 和诊断信息 `diagnostics`：

```bash
node --input-type=module -e "
import { getHltvLiveMatches } from './packages/hltv/dist/index.js';

const result = await getHltvLiveMatches();
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
" > outputs/live-matches.json
```

使用 `jq` 查看精简结果：

```bash
jq '.data.matches[] | {
  id,
  url,
  event: .event.name,
  teams: [.teams[].name],
  scores: [.teams[].score]
}' outputs/live-matches.json
```

当 HLTV 当前没有正在进行的比赛时，返回 `matches: []` 属于正常结果，不代表采集失败。

## 根据 URL 获取单场比赛详情

```bash
MATCH_URL='https://www.hltv.org/matches/<id>/<slug>' \
node --input-type=module -e "
import { getHltvMatch } from './packages/hltv/dist/index.js';

const result = await getHltvMatch(process.env.MATCH_URL);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
" > outputs/match-detail.json
```

`MATCH_URL` 必须是规范的 `https://www.hltv.org/matches/<id>/<slug>` 地址。

## 自动获取第一场进行中比赛的详情

以下命令会先保存进行中比赛列表。如果当前没有比赛，命令会正常退出，并且不会创建详情文件。

```bash
node --input-type=module <<'EOF'
import { mkdir, writeFile } from 'node:fs/promises';
import {
  getHltvLiveMatches,
  getHltvMatch,
} from './packages/hltv/dist/index.js';

await mkdir('outputs', { recursive: true });

const live = await getHltvLiveMatches();
await writeFile('outputs/live-matches.json', JSON.stringify(live, null, 2) + '\n');

const first = live.data.matches[0];
if (!first) {
  console.log('当前没有正在进行的比赛。');
  process.exit(0);
}

const detail = await getHltvMatch(first.url);
await writeFile('outputs/match-detail.json', JSON.stringify(detail, null, 2) + '\n');
console.log(`已保存比赛 ${first.id}。`);
EOF
```

## 获取全部进行中比赛的详情

需要连续采集多场比赛时，应复用同一个 client。首次访问某场比赛时，客户端会按配置的并发数和间隔限制页面导航；之后该比赛会复用常驻页面及其原生 Scorebot 连接，不再进入全局导航队列。不同比赛的已建立会话可以独立读取。当原生 Scorebot 明确切换到下一张地图时，客户端只在该地图边界对同一个页面执行一次 canonical navigation，用刷新后的静态 map cards 固化上一张地图的权威终局比分；普通 warm read 和单纯 Scorebot 暂时缺失都不会触发刷新。

```bash
node --input-type=module <<'EOF'
import { mkdir, writeFile } from 'node:fs/promises';
import { createHltvClient } from './packages/hltv/dist/index.js';

await mkdir('outputs', { recursive: true });

const client = await createHltvClient({
  maxConcurrency: 1,
  minRequestIntervalMs: 5_000,
});

try {
  const live = await client.getLiveMatches({ timeoutMs: 60_000 });
  await writeFile('outputs/live-matches.json', JSON.stringify(live, null, 2) + '\n');

  for (const match of live.data.matches) {
    const detail = await client.getMatch(match.url, { timeoutMs: 180_000 });
    await writeFile(
      `outputs/match-${match.id}.json`,
      JSON.stringify(detail, null, 2) + '\n',
    );
    console.log(`已保存比赛 ${match.id}。`);
  }
} finally {
  await client.close();
}
EOF
```

## 显示进度并保持 JSON 文件纯净

进度信息应写入标准错误（stderr）。这样即使把标准输出（stdout）重定向到文件，生成的内容仍然是有效 JSON：

```js
const onProgress = (event) => {
  console.error(`[${event.operation}:${event.stage}] ${event.message}`);
};

const result = await getHltvLiveMatches({ onProgress });
```

## 只保存业务数据

每项操作都返回 `{ data, diagnostics }`。如果不需要诊断信息，请保存 `result.data`，而不是完整的 `result`：

```js
JSON.stringify(result.data, null, 2)
```

开发或排查字段缺失时，建议保留 `diagnostics`。当 HLTV 页面显示 `-` 时，进行中比分可能合理地返回 `null`；其他不完整字段会通过 `warnings` 说明。

## 设置超时和代理

一次性函数可以同时接收浏览器选项和请求选项：

```js
const result = await getHltvLiveMatches({
  timeoutMs: 60_000,
  timezone: 'UTC',
  proxy: {
    server: 'http://127.0.0.1:8080',
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  },
});
```

比赛详情通常需要更大的超时时间，例如 `180_000` 毫秒。代理凭据不会出现在返回数据、诊断信息、错误或进度事件中。

## 让 Shell 脚本正确感知失败

```js
try {
  const result = await getHltvLiveMatches();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
```

运行失败时会抛出 `HltvError`，其中包含稳定的 `code`、`operation`、`stage` 和 `retryable` 字段，可用于日志记录、重试判断和自动化处理。
