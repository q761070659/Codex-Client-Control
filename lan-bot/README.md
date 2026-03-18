# Codex LAN Bot

这个子项目是给 `Codex Client Control` 配套的高速 `LAN bot`。

它不再遥控你眼前的真实客户端，而是作为第二个玩家直接连进你手动开放的局域网世界，所以连续动作会明显更流畅。

**特性：**

- 基于 mineflayer 的独立机器人
- 自动寻路系统（mineflayer-pathfinder）
- 物品栏管理
- 聊天历史记录
- 托管动作系统
- 批量操作支持

## 当前能力

### HTTP 接口

#### GET 接口

- `GET /` - 根路径，返回基本信息
- `GET /status` - 获取机器人状态（位置、生命值、饥饿值、游戏模式等）
- `GET /full-state` - 获取完整状态（状态 + 玩家 + 物品栏 + 聊天 + 动作）
- `GET /chat` - 读取聊天缓存
- `GET /players` - 读取服务器玩家列表
- `GET /inventory` - 读取物品栏内容
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
- `POST /action/run` - 运行托管动作
- `POST /action/cancel` - 取消当前动作

### 托管动作

`POST /action/run` 已实现的托管动作：

- `move_to` - 自动寻路到目标坐标
- `place_blocks` - 批量放置方块
- `build_small_house` - 建造小型木屋
- `plant_and_bonemeal` - 种植树苗并骨粉催熟

## 安装

在本目录执行：

```powershell
npm.cmd install
```

启动：

```powershell
npm.cmd start
```

首次启动会生成配置：

- `<.minecraft 目录>/config/codex-lan-bot.json`

默认配置：

```json
{
  "bindHost": "127.0.0.1",
  "bindPort": 47863,
  "token": "<自动生成>",
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

发送聊天：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/chat' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"message":"你好，这条消息来自 Codex LAN Bot。"}'
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
  -Body '{"item":"oak_planks","x":32,"y":-59,"z":-15}'
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
