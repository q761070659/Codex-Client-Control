# Codex LAN Bot

这个子项目是给 `Codex Client Control` 配套的高速 `LAN bot`。

它不再遥控你眼前的真实客户端，而是作为第二个玩家直接连进你手动开放的局域网世界，所以连续动作会明显更流畅。

**特性：**

- 基于 mineflayer 的独立机器人
- 自动寻路系统（mineflayer-pathfinder）
- 物品栏管理
- 聊天历史记录
- 世界记忆持久化
- 直接命令与工作流编排
- Agent session / LLM bridge
- WebSocket 实时流控制
- 托管动作系统
- 批量操作支持

## 当前能力

### HTTP 接口

#### GET 接口

- `GET /` - 根路径，返回基本信息
- `GET /status` - 获取机器人状态（位置、生命值、饥饿值、游戏模式等）
- `GET /capabilities` - 读取可直接调用的原子命令列表
- `GET /agent/status` - 读取当前或指定 agent session
- `GET /agent/sessions` - 读取 agent session 列表
- `GET /agent/prompt` - 生成给 LLM 的当前上下文 prompt 包
- `GET /full-state` - 获取完整状态（状态 + 玩家 + 物品栏 + 聊天 + 动作）
- `GET /memory` - 读取持久化世界记忆
- `GET /chat` - 读取聊天缓存
- `GET /players` - 读取服务器玩家列表
- `GET /inventory` - 读取物品栏内容
- `GET /target` - 读取当前准星目标（方块 / 实体）
- `GET /block?x=&y=&z=` - 读取单个方块状态与属性
- `GET /action/status` - 读取托管动作状态

#### POST 接口

- `POST /connect` - 连接到局域网世界
- `POST /disconnect` - 断开连接
- `POST /chat` - 发送聊天消息
- `POST /hotbar` - 切换快捷栏
- `POST /equip` - 装备物品（支持按槽位或物品名）
- `POST /move/to` - 自动寻路到坐标
- `POST /look/at` - 看向指定坐标
- `POST /use/item` - 使用物品（激活方块或物品）
- `POST /place` - 放置方块
- `POST /control/run` - 直接执行一个原子命令
- `POST /workflow/run` - 执行多步原子工作流
- `POST /memory/note` - 记录文本记忆
- `POST /memory/waypoint` - 记录命名坐标点
- `POST /memory/context` - 更新任务上下文
- `POST /agent/start` - 创建一个 agent session
- `POST /agent/message` - 给 session 追加对话消息
- `POST /agent/plan` - 设置或追加 session 计划
- `POST /agent/autoplan` - 调用配置好的 LLM 自动产出计划
- `POST /agent/run` - 执行 session 当前计划
- `POST /agent/step` - 执行单步或当前下一步
- `POST /agent/stop` - 停止 session / 当前动作
- `POST /action/run` - 运行托管动作
- `POST /action/cancel` - 取消当前动作

### WebSocket 实时接口

- `WS /ws?token=<token>` - 长连接实时控制与事件流
- 默认订阅频道：`status`、`action`、`agent`、`memory`、`chat`、`log`
- 适合连续动作、低延迟交互、agent 计划执行和状态流观察

**客户端 -> 服务端消息：**

```json
{ "id": "1", "type": "command", "command": "move_to", "args": { "x": 10, "y": -60, "z": 20, "range": 1 } }
```

```json
{ "id": "2", "type": "workflow", "label": "farm-loop", "steps": [ { "command": "read_status" } ] }
```

```json
{ "id": "3", "type": "agent", "op": "start", "args": { "label": "builder", "goal": "建造工作区" } }
```

```json
{ "id": "4", "type": "subscribe", "channels": ["status", "action", "agent"] }
```

**服务端 -> 客户端消息：**

```json
{ "type": "hello", "clientId": "...", "capabilities": { } }
```

```json
{ "type": "response", "requestId": "1", "ok": true, "result": { } }
```

```json
{ "type": "event", "channel": "status", "payload": { } }
```

### 托管动作

`POST /action/run` 已实现的托管动作：

- `move_to` - 自动寻路到目标坐标
- `place_blocks` - 批量放置方块
- `build_small_house` - 建造小型木屋
- `build_decorated_two_story_house` - 建造带装饰的双层小屋
- `build_rustic_balcony_house` - 建造参考图风格的木石阳台房
- `build_imperial_pagoda` - 多 bot 协作建造大型楼阁寺塔
- `plant_and_bonemeal` - 种植树苗并骨粉催熟

## 安装

在本目录执行：

```powershell
npm.cmd install
```

启动：

```bash
node src/server.js
```

或者：

```bash
npm start
```

首次启动会生成配置：

- `<.minecraft 目录>/config/codex-lan-bot.json`

默认配置：

```json
{
  "bindHost": "127.0.0.1",
  "bindPort": 47863,
  "token": "<自动生成>",
  "agent": {
    "maxSessions": 8,
    "autoSaveDebounceMs": 200,
    "systemPrompt": "You are Codex LAN Agent...",
    "llm": {
      "enabled": false,
      "provider": "openai_compatible",
      "baseUrl": "",
      "model": "",
      "apiKeyEnv": "OPENAI_API_KEY",
      "headers": {}
    }
  },
  "bot": {
    "host": "127.0.0.1",
    "port": -1,
    "username": "CodexLanBot",
    "auth": "offline",
    "version": "auto",
    "connectTimeoutMs": 20000
  }
}
```

配置说明：

- `bindHost` / `bindPort` - HTTP 接口监听地址
- `token` - 认证令牌，首次启动自动生成
- `agent.maxSessions` - 本地最多保留多少个 agent session
- `agent.systemPrompt` - session 默认系统提示词
- `agent.llm.*` - OpenAI-compatible LLM 网关配置；启用后可直接 `POST /agent/autoplan`
- `bot.host` / `bot.port` - 局域网世界地址，`port = -1` 时自动从 `latest.log` 检测
- `bot.username` - 机器人用户名
- `bot.auth` - 认证模式（`offline` 为离线模式）
- `bot.version` - 游戏版本（`auto` 自动匹配）
- `bot.connectTimeoutMs` - 连接超时时间（毫秒）

当 `port = -1` 时，会优先尝试从 `latest.log` 里读取最近一次开放局域网的端口。

## 示例

读取 token：

```powershell
$token = (Get-Content '<.minecraft 目录>\config\codex-lan-bot.json' | ConvertFrom-Json).token
```

读取可用原子命令：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/capabilities' -Headers @{ 'X-Auth-Token' = $token }
```

WebSocket 地址：

```text
ws://127.0.0.1:47863/ws?token=<token>
```

创建一个 agent session：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/agent/start' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "label": "builder",
    "goal": "手动建一个带箱子和熔炉的小工作区",
    "mode": "llm_bridge"
  }'
```

连接 LAN 世界：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/connect' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{}'
```

如果自动检测不到端口，可以显式传入：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/connect' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"port":55916,"username":"CodexLanBot"}'
```

断开连接：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/disconnect' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{}'
```

读取状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/status' -Headers @{ 'X-Auth-Token' = $token }
```

获取完整状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/full-state' -Headers @{ 'X-Auth-Token' = $token }
```

读取记忆：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/memory' -Headers @{ 'X-Auth-Token' = $token }
```

读取准星目标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/target?maxDistance=6' -Headers @{ 'X-Auth-Token' = $token }
```

读取物品栏：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/inventory' -Headers @{ 'X-Auth-Token' = $token }
```

读取玩家列表：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/players' -Headers @{ 'X-Auth-Token' = $token }
```

读取动作状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/status' -Headers @{ 'X-Auth-Token' = $token }
```

`GET /action/status` 在大型建筑动作运行时会额外返回 `details.stage`，里面包含当前阶段、已完成数、失败数、分工策略以及每个 worker 的分块范围。

发送聊天：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/chat' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"message":"你好，这条消息来自 Codex LAN Bot。"}'
```

直接调用一个原子命令：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/control/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "command": "move_to",
    "args": {
      "x": 40,
      "y": -60,
      "z": 20,
      "range": 1
    }
  }'
```

执行一个带记忆引用的工作流：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/workflow/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "label": "fish-setup",
    "steps": [
      { "command": "read_status", "saveAs": "status" },
      { "command": "memory_waypoint", "args": { "name": "here", "x": "$named.status.x", "y": "$named.status.y", "z": "$named.status.z" } },
      { "command": "memory_note", "args": { "text": "开始手动流程测试", "tag": "workflow" } }
    ]
  }'
```

读取给 LLM 的 prompt 包：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/agent/prompt' -Headers @{ 'X-Auth-Token' = $token }
```

把计划写入 session：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/agent/plan' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "steps": [
      { "command": "move_to", "args": { "x": 40, "y": -60, "z": 20, "range": 1 } },
      { "command": "memory_note", "args": { "text": "到达工作区", "tag": "agent" } }
    ]
  }'
```

执行当前 agent 计划：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/agent/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{}'
```

记录一个命名坐标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/memory/waypoint' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"name":"storage","x":88,"y":-60,"z":14,"note":"主箱子"}'
```

切换快捷栏：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/hotbar' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"slot":3}'
```

装备物品（按物品名）：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/equip' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"item":"diamond_pickaxe"}'
```

让 bot 走到坐标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/move/to' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":40,"y":-60,"z":20,"range":1}'
```

看向指定坐标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/look/at' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":32,"y":-60,"z":-15}'
```

使用/激活方块：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/use/item' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":32,"y":-59,"z":-15}'
```

放置方块：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/place' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "item": "spruce_slab",
    "x": 32,
    "y": -59,
    "z": -15,
    "supportX": 31,
    "supportY": -59,
    "supportZ": -15,
    "faceX": 1,
    "faceY": 0,
    "faceZ": 0,
    "deltaX": 1,
    "deltaY": 0.75,
    "deltaZ": 0.5,
    "replace": true
  }'
```

批量放置方块：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "place_blocks",
    "placements": [
      {"x":32,"y":-59,"z":-15,"item":"oak_planks"},
      {"x":33,"y":-59,"z":-15,"item":"oak_planks"},
      {"x":34,"y":-59,"z":-15,"item":"oak_planks"}
    ],
    "range": 4,
    "continueOnError": true
  }'
```

批量种树苗并骨粉催熟：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "plant_and_bonemeal",
    "positions": [
      {"x":40,"y":-60,"z":20},
      {"x":44,"y":-60,"z":20},
      {"x":48,"y":-60,"z":20}
    ],
    "sapling": "oak_sapling",
    "bonemeal": "bone_meal",
    "successBlock": "oak_log",
    "triesPerPosition": 16,
    "useDelayMs": 250,
    "range": 4
  }'
```

手工逐块盖一个小木屋：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "build_small_house",
    "x": 32,
    "y": -60,
    "z": -15,
    "wallItem": "oak_planks",
    "roofItem": "oak_planks",
    "windowItem": "glass_pane",
    "lightItem": "torch",
    "range": 4,
    "continueOnError": false
  }'
```

手工逐块盖一个带装饰的双层小屋：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "build_decorated_two_story_house",
    "x": 60,
    "y": -61,
    "z": -18,
    "stairItem": "spruce_slab",
    "range": 4,
    "continueOnError": false
  }'
```

手工逐块盖一个参考图风格的木石阳台房：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "build_rustic_balcony_house",
    "x": 96,
    "y": -61,
    "z": -18,
    "placeDelayMs": 180,
    "continueOnError": false
  }'
```

多 bot 协作盖大型楼阁寺塔：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "action": "build_imperial_pagoda",
    "x": 220,
    "y": -61,
    "z": -30,
    "workers": 4,
    "workerMode": "auto",
    "helperPrefix": "CodexLanBot",
    "placeDelayMs": 50,
    "roofRange": 12,
    "continueOnError": true
  }'
```

取消当前动作：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/cancel' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{}'
```

## 说明

### 托管动作参数

**move_to** - 自动寻路

- `x`, `y`, `z` - 目标坐标
- `range` - 目标范围（默认 1）

**place_blocks** - 批量放置

- `placements` - 放置位置数组 `[{x, y, z, item}, ...]`
- `range` - 放置范围（默认 4）
- `placeDelayMs` - 放置延迟（默认 150ms）
- `replace` - 是否替换已有方块（默认 false）
- `continueOnError` - 出错时是否继续（默认 false）

**build_small_house** - 建造小屋

- `x`, `y`, `z` - 小屋起始坐标
- `wallItem` - 墙体方块
- `roofItem` - 屋顶方块（默认同 wallItem）
- `windowItem` - 窗户方块（默认 glass_pane）
- `lightItem` - 照明方块（默认 torch）
- `range` - 放置范围（默认 4）
- `continueOnError` - 出错时是否继续（默认 false）

**build_decorated_two_story_house** - 建造双层小屋

- `x`, `y`, `z` - 小屋起始坐标
- `foundationItem` - 地基方块（默认 stone_bricks）
- `floorItem` - 楼板方块（默认 spruce_planks）
- `wallItem` - 墙体方块（默认 birch_planks）
- `pillarItem` - 立柱方块（默认 oak_log）
- `roofItem` - 屋顶方块（默认 dark_oak_planks）
- `windowItem` - 窗户方块（默认 glass_pane）
- `fenceItem` - 栏杆方块（默认 oak_fence）
- `lightItem` - 照明方块（默认 lantern）
- `leafItem` - 外饰树叶方块（默认 oak_leaves）
- `doorItem` - 门方块（默认 oak_door）
- `stairItem` - 室内楼梯方块（默认自动匹配为 `floorItem` 的半砖，如 `spruce_slab`）
- `range` - 放置范围（默认 4）
- `continueOnError` - 出错时是否继续（默认 false）

**build_rustic_balcony_house** - 建造木石阳台房

- `x`, `y`, `z` - 小屋起始坐标
- `foundationItem` - 石质主体方块（默认 cobblestone）
- `baseAccentItem` - 石质描边方块（默认 stone_bricks）
- `floorItem` - 地板方块（默认 spruce_planks）
- `wallItem` - 木墙方块（默认 spruce_planks）
- `beamItem` - 木梁方块（默认 stripped_spruce_log）
- `roofItem` - 主屋顶方块（默认 dark_oak_planks）
- `roofAccentItem` - 屋顶脊线方块（默认自动匹配 `roofItem` 半砖）
- `windowItem` - 窗户方块（默认 glass_pane）
- `fenceItem` - 阳台栏杆方块（默认 spruce_fence）
- `lightItem` - 灯具方块（默认 lantern）
- `doorItem` - 门方块（默认 spruce_door）
- `leafItem` - 绿化方块（默认 oak_leaves）
- `stairItem` - 室内楼梯方块（默认自动匹配为 `floorItem` 的半砖）
- `placeDelayMs` - 放置延迟（默认 150ms）
- `roofRange` - 放屋顶时的最大可达范围（默认至少 8）
- `range` - 放置范围（默认 4）
- `continueOnError` - 出错时是否继续（默认 false）

**build_imperial_pagoda** - 多 bot 协作建造大型楼阁寺塔

- `x`, `y`, `z` - 建筑基准坐标
- `plotItem` / `plotBorderLightItem` / `plotBorderDarkItem` - 地台与边框材质
- `podiumItem` / `podiumAccentItem` / `podiumStairBlockItem` / `podiumStairSlabItem` - 台基与前阶材质
- `terraceItem` / `beamItem` / `pillarItem` / `accentItem` - 楼层平台、木梁、立柱、腰线材质
- `wallItem` / `windowItem` / `railingItem` - 墙体、窗格、栏杆材质
- `eaveItem` / `roofItem` / `roofAccentItem` - 飞檐、屋面、屋脊材质
- `ornamentItem` / `ornamentBaseItem` / `lanternItem` / `doorItem` - 装饰、灯具和门材质
- `stairBlockItem` / `stairSlabItem` - 内部可走楼梯使用的整块与半砖
- `workers` - 参与施工的 bot 总数，包含主 bot（默认 4）
- `helperPrefix` - 辅助 bot 名称前缀，实际会生成如 `CodexLanBot1`
- `workerMode` - 分工模式：`auto`、`lanes`、`grid`、`round_robin`
- `placeDelayMs` - 放置延迟（默认 150ms）
- `roofRange` - 屋顶阶段可达范围（默认至少 10）
- `range` - 普通阶段可达范围（默认 4）
- `continueOnError` - 出错时是否继续（默认 false）

**POST /place** - 单块放置补充参数

- `supportX`, `supportY`, `supportZ` - 指定支撑方块坐标
- `faceX`, `faceY`, `faceZ` - 指定点击支撑方块的面
- `deltaX`, `deltaY`, `deltaZ` - 指定点击面的光标位置（0-1）
- `half` - 放置半砖时指定 `top` 或 `bottom`
- `replace` - 目标已有方块时先挖掉再放

**plant_and_bonemeal** - 种植催熟

- `positions` - 种植位置数组 `[{x, y, z}, ...]`
- `sapling` - 树苗名称（默认 oak_sapling）
- `bonemeal` - 骨粉名称（默认 bone_meal）
- `successBlock` - 成功判断方块（默认 oak_log）
- `triesPerPosition` - 每个位置最大尝试次数（默认 16）
- `useDelayMs` - 使用延迟（默认 250ms）
- `range` - 操作范围（默认 4）

### 错误处理

所有接口失败时会返回如下格式的错误响应：

```json
{
  "ok": false,
  "error": "错误信息"
}
```

HTTP 状态码：

- `200` - 成功
- `400` - 请求参数错误
- `401` - 缺少或错误的 `X-Auth-Token`
- `404` - 接口不存在

### 注意事项

- 所有坐标都是绝对坐标，不是相对坐标
- 物品名称使用 Minecraft 内部名称（如 `oak_planks`、`diamond_pickaxe`）
- 托管动作执行时，可以通过 `POST /action/cancel` 中断
- 机器人需要能够到达目标位置才能进行操作
- 某些操作可能需要先装备正确的物品

## 依赖

- Node.js 18+
- mineflayer
- mineflayer-pathfinder
- minecraft-protocol

## 构建

无需构建，直接运行：

```powershell
npm.cmd install
npm.cmd start
```
