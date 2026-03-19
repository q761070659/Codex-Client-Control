# Codex Client Control

*给 AI，尤其是 Codex，一个能真正操作 Minecraft 客户端的本地接口。*

Codex Client Control 的出发点其实很明确：现在很多 AI 已经能写 Minecraft 相关代码、分析问题、规划流程，但一旦到了“真的去操作客户端”这一步，通常就断掉了。

所以这个 mod 做的事情，就是把本地正在运行的 Minecraft 客户端接成一个可调用的控制端。游戏启动后，它会在本机 `127.0.0.1` 打开一个带 token 的 HTTP / WebSocket 接口，让外部程序能读取客户端状态，也能把真实输入重新送回客户端。

这里说的“外部程序”，我最开始就是按 Codex 来想的，所以名字前面直接用了 `Codex`。这个项目本质上就是想给 Codex 一只手，让它不只是停留在文本层面，而是真的能去看、去点、去移动、去执行。

我选 HTTP 也是同样的思路：简单、直观、容易调试，而且对 AI 很友好。只要一个代理能发本地请求，它就能开始控制这个客户端，不需要额外塞一套复杂脚本运行时进去。

简单一点说，你可以从外部脚本里让客户端前后左右移动、发送聊天、切快捷栏、操作 GUI、读取容器、查看准星目标，或者执行一段编排好的动作序列。

## 适合用来做什么

- 给 Codex 或其他能发 HTTP 请求的 AI 代理接入 Minecraft 客户端
- 写本地自动化脚本，处理重复操作或联调流程
- 给客户端接一个控制面板、桌面助手或测试工具
- 做需要“真实客户端反馈”的实验，而不是只发命令不看结果
- 把 Minecraft 接到你自己的工作流、工具链或外部程序里

如果你要的是更长时间、更高频的连续操作，仓库里还有一个独立的 `lan-bot` 子项目。它适合另一类场景；这个模组更偏向把“当前客户端”开放成一个稳定、可观察、可控制的本地接口。详见 [lan-bot/README.md](lan-bot/README.md)。

## 能直接控制哪些东西

- 玩家状态：位置、朝向、血量、饥饿值、快捷栏等
- 输入操作：前后左右、跳跃、潜行、疾跑、交互、攻击、视角、快捷栏
- 聊天与命令：发送聊天、执行命令、读取聊天缓存
- GUI 与容器：关闭界面、点击、滚轮、键盘输入、读取控件和容器内容
- 环境信息：准星目标、在线玩家列表、截图
- 编排能力：动作序列、托管动作、WebSocket 实时订阅
- 调试能力：本地调试假人

## 为什么叫 Codex

因为这个项目一开始就不是在做一个泛泛的“客户端控制 mod”。

我的目标更具体：我想给 Codex 一个真正能落到 Minecraft 客户端上的控制桥，让它可以通过本地 HTTP 接口去访问状态、发送动作、执行测试，而不是只停留在“告诉你下一步该怎么做”。

现在这套接口当然也能被别的脚本、桌面工具或者 AI 使用，但它的起点确实就是 Codex，这也是名字保留下来的原因。

## 快速开始

1. 启动一次游戏，让模组生成配置文件：`config/codex-client-control.properties`
2. 读取配置里的 `token`
3. 用带 `X-Auth-Token` 的请求访问 `http://127.0.0.1:47862/status`，确认接口已经可用

PowerShell 简例：

```powershell
$token = (Get-Content .\config\codex-client-control.properties | Select-String '^token=').ToString().Split('=')[1]
Invoke-RestMethod 'http://127.0.0.1:47862/status' -Headers @{ 'X-Auth-Token' = $token }
```

## 构建

默认会构建 `gradle.properties` 里 `default_minecraft_version` 指向的版本，产物文件名会自动附带对应的 Minecraft 版本号。

常用构建方式：

- 构建默认版本：`gradlew build`
- 构建 `1.21.11`：`gradlew buildMods1_21_11`
- 构建 `1.21.8`：`gradlew buildMods1_21_8`
- 一次性构建全部已支持版本：`gradlew buildAllSupportedMods`
- 收集当前版本产物到根目录发布区：`gradlew collectCurrentMods`

如果你确实想手动覆盖版本属性，在 Windows PowerShell 里请给 `minecraft_version` 加引号，或者直接用上面的版本任务名。

产物目录：

- Fabric: `fabric/build/<minecraft_version>/libs/`
- NeoForge: `neoforge/build/<minecraft_version>/libs/`
- 聚合发布目录: `build/release/<minecraft_version>/`

如果你准备上传 Modrinth，可直接参考根目录里的 `MODRINTH_DESCRIPTION.md`。

## 已实现接口

### HTTP 接口

#### GET 接口

- `GET /` - 根路径，返回基本信息
- `GET /status` - 获取客户端状态
- `GET /full-state` - 获取完整状态（状态 + 聊天 + 屏幕 + 目标 + 容器 + 玩家列表）
- `GET /chat` - 读取聊天缓存
- `GET /screen` - 读取当前 GUI 信息和可见控件
- `GET /target` - 读取准星目标
- `GET /container` - 读取当前容器内容
- `GET /players` - 读取玩家列表
- `GET /debug/fake-player` - 读取本地调试假人列表
- `GET /action/status` - 读取托管动作状态

#### POST 接口

- `POST /chat` - 发送聊天消息
- `POST /command` - 执行命令
- `POST /look` - 转动视角
- `POST /key` - 按住/松开按键
- `POST /input` - 应用综合控制状态（按键 + 视角 + 快捷栏）
- `POST /tap` - 轻点按键
- `POST /hotbar` - 切换快捷栏
- `POST /release-all` - 松开所有常用控制键
- `POST /gui/close` - 关闭当前 GUI
- `POST /gui/click` - 点击 GUI 坐标
- `POST /gui/release` - 松开 GUI 鼠标按键
- `POST /gui/scroll` - 滚动 GUI
- `POST /gui/key` - 向 GUI 发送按键
- `POST /gui/type` - 向 GUI 输入文本
- `POST /gui/click-widget` - 按控件索引点击按钮
- `POST /screenshot` - 截图
- `POST /sequence` - 执行动作序列
- `POST /action/run` - 运行托管动作
- `POST /action/cancel` - 取消托管动作
- `POST /debug/fake-player/spawn` - 生成本地调试假人
- `POST /debug/fake-player/move` - 移动本地调试假人
- `POST /debug/fake-player/remove` - 移除本地调试假人
- `POST /debug/fake-player/clear` - 清空本地调试假人

### WebSocket 接口

连接到 `ws://127.0.0.1:47862/ws`，需要携带 `X-Auth-Token` 请求头。

支持的动作（action）：

- `ping` - 心跳检测
- `status` - 获取状态
- `full-state` - 获取完整状态
- `chat` / `chat.read` - 读取/发送聊天
- `subscribe` / `unsubscribe` / `subscriptions` - 订阅管理
- `screen` - 获取屏幕快照
- `target` - 获取准星目标
- `container` - 获取容器内容
- `players` - 获取玩家列表
- `action.status` / `action.run` / `action.cancel` - 托管动作
- `command` - 执行命令
- `look` - 转动视角
- `key` - 按键控制
- `input` - 综合输入控制
- `tap` - 轻点按键
- `hotbar` - 切换快捷栏
- `release-all` - 松开所有按键
- `gui.close` / `gui.click` / `gui.release` / `gui.scroll` / `gui.key` / `gui.type` / `gui.click-widget` - GUI 操作
- `screenshot` - 截图
- `sequence` - 动作序列
- `debug.fake-player` / `debug.fake-player.spawn` / `debug.fake-player.move` / `debug.fake-player.remove` / `debug.fake-player.clear` - 调试假人

所有请求都需要带 `X-Auth-Token` 请求头。

配置文件首次启动后会生成在：

- `config/codex-client-control.properties`

默认配置：

- `host=127.0.0.1`
- `port=47862`
- `token=<自动生成>`

配置会在模组首次启动时自动生成，如果文件已存在则读取现有配置。

## PowerShell 示例

先读取 token：

```powershell
$token = (Get-Content .\versions\1.21.11far\config\codex-client-control.properties | Select-String '^token=').ToString().Split('=')[1]
```

查看状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/status' -Headers @{ 'X-Auth-Token' = $token }
```

获取完整状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/full-state' -Headers @{ 'X-Auth-Token' = $token }
```

读取聊天缓存：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/chat?limit=20&since=0' -Headers @{ 'X-Auth-Token' = $token }
```

读取当前 GUI 信息和可见控件：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/screen' -Headers @{ 'X-Auth-Token' = $token }
```

读取准星目标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/target' -Headers @{ 'X-Auth-Token' = $token }
```

读取当前容器内容：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/container' -Headers @{ 'X-Auth-Token' = $token }
```

读取玩家列表：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/players' -Headers @{ 'X-Auth-Token' = $token }
```

读取托管动作状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/action/status' -Headers @{ 'X-Auth-Token' = $token }
```

发送聊天：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/chat' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"message":"你好，这条消息来自 Codex。"}'
```

执行命令：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/command' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"command":"spawn"}'
```

应用综合控制状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/input' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{
    "keys": {"forward": true, "sprint": true},
    "yaw": 90.0,
    "pitch": 10.0,
    "hotbar": 3
  }'
```

转动视角：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/look' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"deltaYaw":30,"pitch":15}'
```

按住前进：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/key' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"key":"forward","state":true}'
```

轻点跳跃：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/tap' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"key":"jump","durationMs":120}'
```

切到 3 号快捷栏：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/hotbar' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"slot":3}'
```

松开所有常用控制键：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/release-all' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token }
```

点击 GUI 坐标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/click' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":320,"y":180,"button":0}'
```

滚动 GUI：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/scroll' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":320,"y":180,"deltaY":-1}'
```

向当前 GUI 输入文本：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/type' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"text":"hello codex"}'
```

向当前 GUI 发送按键：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/key' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"key":257,"scancode":28,"modifiers":0}'
```

按 `GET /screen` 返回的控件索引点击按钮：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/click-widget' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"index":0,"button":0}'
```

截图：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/screenshot' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"name":"codex-shot"}'
```

动作序列：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/sequence' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"steps":[{"action":"look","deltaYaw":45},{"action":"move","forward":true,"sprint":true,"durationMs":800},{"action":"wait","durationMs":200},{"action":"tap","key":"jump","durationMs":120}]}'
```

运行托管动作：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"action":"move_to","x":100,"y":64,"z":200}'
```

取消托管动作：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/action/cancel' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"id":1}'
```

生成一个本地调试假人：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/debug/fake-player/spawn' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"name":"CodexDummy","x":0,"y":80,"z":0,"nameVisible":true}'
```

移动本地调试假人：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/debug/fake-player/move' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"name":"CodexDummy","x":2,"y":80,"z":2,"yaw":180}'
```

读取本地调试假人：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/debug/fake-player' -Headers @{ 'X-Auth-Token' = $token }
```

清空本地调试假人：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/debug/fake-player/clear' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token }
```

关闭当前 GUI：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/close' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token }
```

## WebSocket 示例

使用 PowerShell 连接 WebSocket（需要 PowerShell 7+ 或使用其他 WebSocket 客户端）：

```powershell
# 使用 System.Net.WebSockets 连接
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.SetRequestHeader('X-Auth-Token', $token)
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$ws.ConnectAsync('ws://127.0.0.1:47862/ws', [System.Threading.CancellationToken]::None).Wait()

# 发送消息
$message = @{
    action = 'ping'
    id = 1
} | ConvertTo-Json
$sendBytes = [System.Text.Encoding]::UTF8.GetBytes($message)
$ws.SendAsync($sendBytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()

# 接收消息
$buffer = New-Object byte[] 1024
$receive = $ws.ReceiveAsync($buffer, [System.Threading.CancellationToken]::None).Result
$response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $receive.Count)
Write-Host $response

$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'Close', [System.Threading.CancellationToken]::None).Wait()
```

订阅实时推送：

```json
{
  "action": "subscribe",
  "topics": ["status", "screen", "target", "container", "players", "chat", "full-state", "action"]
}
```

订阅后会每 25ms 推送一次订阅的 topic 数据。

取消订阅：

```json
{
  "action": "unsubscribe",
  "topics": ["status", "screen"]
}
```

查看当前订阅：

```json
{
  "action": "subscriptions"
}
```

## 说明

- `POST /sequence` 是动作序列接口，适合脚本化移动/等待/GUI 组合，不是完整寻路算法。
- `POST /action/run` 是托管动作接口，会异步执行预定义的动作（如 `move_to`、`place_blocks` 等），可以通过 `POST /action/cancel` 取消。
- `POST /input` 是综合输入接口，可以同时设置按键状态、视角和快捷栏，适合需要精确同步的操作。
- `POST /debug/fake-player/*` 创建的是客户端本地调试实体，只在你自己的客户端里可见，服务器和其他玩家不会把它当成真实玩家。
- WebSocket 接口支持实时推送，订阅后每 25ms 推送一次数据，适合需要高频状态更新的场景。
- 所有 GUI 操作都需要当前有打开的 GUI 界面，否则可能会失败。
- `POST /gui/click-widget` 使用 `GET /screen` 返回的控件索引，索引从 0 开始。

## 错误处理

所有接口失败时会返回如下格式的错误响应：

```json
{
  "error": "错误信息"
}
```

HTTP 状态码：

- `200` - 成功
- `400` - 请求参数错误
- `401` - 缺少或错误的 `X-Auth-Token`
- `404` - 接口不存在
- `500` - 服务器内部错误

## 构建环境

- Java 21
- Fabric Loader `0.18.4`
- Minecraft `1.21.11` / `1.21.8`
- Fabric API 与 NeoForge 版本会按目标 Minecraft 版本自动解析


## 引用说明：
引用的是发表于论文的《Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning》
https://arxiv.org/abs/2504.17950
