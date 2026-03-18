# Codex Client Control

这是一个给 `1.21.11 Fabric` 和 `1.21.11 NeoForge_21.11.38-beta` 准备的客户端控制模组。

它启动后会在本机开启一个只监听 `127.0.0.1` 的 HTTP 接口，方便通过脚本控制当前客户端。

**特性：**

- HTTP REST API
- WebSocket 实时推送与控制
- 完整的 GUI 操作支持
- 动作序列与托管任务
- 本地调试假人实体

如果你要更高频、更丝滑的连续动作，仓库里还有一个独立的 `LAN bot` 子项目：

- `lan-bot`

它会作为第二个玩家直接加入你手动开放的局域网世界，适合寻路、连续放置、骨粉催熟、采集这类动作密集任务。详见 [lan-bot/README.md](lan-bot/README.md)。

当前会同时构建两个版本：

- Fabric: `build/codex-client-control-fabric-1.0.0+1.21.11.jar`
- NeoForge: `build/codex-client-control-neoforge-1.0.0+1.21.11.jar`

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

## 构建

使用 Gradle 构建：

```powershell
.\gradlew build
```

构建产物：

- Fabric: `build/codex-client-control-fabric-1.0.0+1.21.11.jar`
- NeoForge: `build/codex-client-control-neoforge-1.0.0+1.21.11.jar`

## 依赖

- Minecraft 1.21.11
- Fabric Loader 0.18.4+ / Fabric API 0.127.0+1.21.11
- NeoForge 21.11.38-beta
- Java 21
