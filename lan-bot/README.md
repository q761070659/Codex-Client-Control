# Codex LAN Bot

这个子项目是给 `Codex Client Control` 配套的高速 `LAN bot`。

它不再遥控你眼前的真实客户端，而是作为第二个玩家直接连进你手动开放的局域网世界，所以连续动作会明显更流畅。

## 当前能力

- `POST /connect`
- `POST /disconnect`
- `GET /status`
- `GET /full-state`
- `GET /chat`
- `GET /players`
- `GET /inventory`
- `GET /action/status`
- `POST /chat`
- `POST /hotbar`
- `POST /equip`
- `POST /move/to`
- `POST /look/at`
- `POST /use/item`
- `POST /place`
- `POST /action/run`
- `POST /action/cancel`

其中 `POST /action/run` 目前已实现：

- `place_blocks`
- `build_small_house`
- `move_to`
- `plant_and_bonemeal`

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

- `C:\Users\qs761\Desktop\.minecraft\config\codex-lan-bot.json`

默认配置：

```json
{
  "bindHost": "127.0.0.1",
  "bindPort": 47863,
  "token": "auto-generated",
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

当 `port = -1` 时，会优先尝试从 `latest.log` 里读取最近一次开放局域网的端口。

## 示例

连接 LAN 世界：

```powershell
$token = (Get-Content 'C:\Users\qs761\Desktop\.minecraft\config\codex-lan-bot.json' | ConvertFrom-Json).token
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

读取状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/status' -Headers @{ 'X-Auth-Token' = $token }
```

让 bot 走到坐标：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/move/to' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"x":40,"y":-60,"z":20,"range":1}'
```

批量种树苗并骨粉催熟：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"action":"plant_and_bonemeal","positions":[{"x":40,"y":-60,"z":20},{"x":44,"y":-60,"z":20},{"x":48,"y":-60,"z":20}],"sapling":"oak_sapling","bonemeal":"bone_meal","successBlock":"oak_log"}'
```

手工逐块盖一个小木屋：

```powershell
Invoke-RestMethod 'http://127.0.0.1:47863/action/run' `
  -Method Post `
  -Headers @{ 'X-Auth-Token' = $token } `
  -ContentType 'application/json' `
  -Body '{"action":"build_small_house","x":32,"y":-60,"z":-15,"wallItem":"oak_planks","windowItem":"glass_pane","lightItem":"torch"}'
```
