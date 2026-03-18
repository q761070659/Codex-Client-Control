# Codex Client Control

这是一个给 `1.21.11far` 和 `1.21.11-NeoForge_21.11.38-beta` 准备的客户端控制模组。

它启动后会在本机开启一个只监听 `127.0.0.1` 的 HTTP 接口，方便通过脚本控制当前客户端。

如果你要更高频、更丝滑的连续动作，现在仓库里还新增了一个独立的 `LAN bot` 子项目：

- `lan-bot`

它会作为第二个玩家直接加入你手动开放的局域网世界，适合寻路、连续放置、骨粉催熟、采集这类动作密集任务。

当前会同时构建两个版本：

- Fabric: `build/codex-client-control-fabric-1.0.0+1.21.11.jar`
- NeoForge: `build/codex-client-control-neoforge-1.0.0+1.21.11.jar`

## 已实现接口

- `GET /status`
- `GET /chat`
- `GET /screen`
- `GET /target`
- `GET /container`
- `GET /players`
- `GET /debug/fake-player`
- `POST /chat`
- `POST /command`
- `POST /look`
- `POST /key`
- `POST /tap`
- `POST /hotbar`
- `POST /release-all`
- `POST /gui/close`
- `POST /gui/click`
- `POST /gui/release`
- `POST /gui/scroll`
- `POST /gui/key`
- `POST /gui/type`
- `POST /gui/click-widget`
- `POST /screenshot`
- `POST /sequence`
- `POST /debug/fake-player/spawn`
- `POST /debug/fake-player/move`
- `POST /debug/fake-player/remove`
- `POST /debug/fake-player/clear`

所有请求都需要带 `X-Auth-Token` 请求头。

配置文件首次启动后会生成在：

- `config/codex-client-control.properties`

默认配置：

- `host=127.0.0.1`
- `port=47862`
- `token=<自动生成>`

## PowerShell 示例

先读取 token：

```powershell
$token = (Get-Content .\versions\1.21.11far\config\codex-client-control.properties | Select-String '^token=').ToString().Split('=')[1]
```

查看状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/status' -Headers @{ 'X-Auth-Token' = $token }
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

## 说明

- `POST /sequence` 是动作序列接口，适合脚本化移动/等待/GUI 组合，不是完整寻路算法。
- `POST /debug/fake-player/*` 创建的是客户端本地调试实体，只在你自己的客户端里可见，服务器和其他玩家不会把它当成真实玩家。
