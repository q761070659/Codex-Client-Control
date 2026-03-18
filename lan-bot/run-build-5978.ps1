$ErrorActionPreference = 'Stop'
$token = (Get-Content 'C:\Users\qs761\Desktop\.minecraft\config\codex-lan-bot.json' | ConvertFrom-Json).token
$resultPath = 'C:\Users\qs761\Desktop\.minecraft\codex-client-control\Codex Client Control\lan-bot\build-imperial-pagoda-5978.json'
$errorPath = 'C:\Users\qs761\Desktop\.minecraft\codex-client-control\Codex Client Control\lan-bot\build-imperial-pagoda-5978.err.txt'
$payload = @{
  action = 'build_imperial_pagoda'
  x = 260
  y = -61
  z = -40
  workers = 4
  workerMode = 'auto'
  helperPrefix = 'CodexLanBot'
  placeDelayMs = 50
  roofRange = 14
  continueOnError = $true
  plotItem = 'sandstone'
  plotBorderLightItem = 'quartz_block'
  plotBorderDarkItem = 'smooth_stone'
  podiumItem = 'stone_bricks'
  podiumAccentItem = 'stone_brick_wall'
  podiumStairBlockItem = 'stone_bricks'
  podiumStairSlabItem = 'stone_brick_slab'
  terraceItem = 'spruce_planks'
  beamItem = 'dark_oak_log'
  pillarItem = 'quartz_pillar'
  accentItem = 'emerald_block'
  wallItem = 'red_terracotta'
  windowItem = 'green_stained_glass'
  railingItem = 'dark_oak_fence'
  eaveItem = 'acacia_planks'
  roofItem = 'dark_oak_planks'
  roofAccentItem = 'acacia_slab'
  ornamentItem = 'quartz_block'
  ornamentBaseItem = 'chiseled_stone_bricks'
  lanternItem = 'lantern'
  doorItem = 'spruce_door'
  stairBlockItem = 'spruce_planks'
  stairSlabItem = 'spruce_slab'
} | ConvertTo-Json -Depth 8 -Compress
try {
  Invoke-RestMethod 'http://127.0.0.1:47872/action/run' -Method Post -Headers @{ 'X-Auth-Token' = $token } -ContentType 'application/json' -Body $payload | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $resultPath
}
catch {
  ($_.Exception.Message + [Environment]::NewLine + $_.ErrorDetails.Message) | Set-Content -Encoding UTF8 $errorPath
  throw
}
