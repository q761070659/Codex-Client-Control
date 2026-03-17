# Codex Client Control

这是一个给 `1.21.11far` 实例准备的 Fabric 客户端控制模组。

它启动后会在本机开启一个只监听 `127.0.0.1` 的 HTTP 接口，方便通过脚本控制当前客户端。

## 已实现接口

- `GET /status`
- `GET /chat`
- `GET /screen`
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

关闭当前 GUI：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47862/gui/close' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token }
```
