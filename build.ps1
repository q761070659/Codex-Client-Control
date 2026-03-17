$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir = Join-Path $ProjectRoot "build"
$ClassesDir = Join-Path $BuildDir "classes"
$FabricStageDir = Join-Path $BuildDir "stage-fabric"
$NeoForgeStageDir = Join-Path $BuildDir "stage-neoforge"
$FabricJar = Join-Path $BuildDir "codex-client-control-fabric-1.0.0+1.21.11.jar"
$NeoForgeJar = Join-Path $BuildDir "codex-client-control-neoforge-1.0.0+1.21.11.jar"
$MinecraftRoot = Resolve-Path (Join-Path $ProjectRoot "..\\..")
$FabricInstallDir = Join-Path $MinecraftRoot "versions\\1.21.11far\\mods"
$NeoForgeInstallDir = Join-Path $MinecraftRoot "versions\\1.21.11-NeoForge_21.11.38-beta\\mods"

$FabricLoaderJar = Join-Path $MinecraftRoot "libraries\\net\\fabricmc\\fabric-loader\\0.18.4\\fabric-loader-0.18.4.jar"
$GsonJar = Join-Path $MinecraftRoot "libraries\\com\\google\\code\\gson\\gson\\2.13.2\\gson-2.13.2.jar"
$NeoForgeJarDependency = Join-Path $MinecraftRoot "libraries\\net\\neoforged\\neoforge\\21.11.38-beta\\neoforge-21.11.38-beta-universal.jar"
$NeoForgeLoaderJar = Join-Path $MinecraftRoot "libraries\\net\\neoforged\\fancymodloader\\loader\\10.0.36\\loader-10.0.36.jar"
$NeoForgeBusJar = Join-Path $MinecraftRoot "libraries\\net\\neoforged\\bus\\8.0.5\\bus-8.0.5.jar"
$NeoForgeApiJar = Join-Path $MinecraftRoot "libraries\\net\\neoforged\\mergetool\\2.0.3\\mergetool-2.0.3-api.jar"

if (-not (Test-Path $FabricLoaderJar)) {
    throw "Missing Fabric Loader jar: $FabricLoaderJar"
}

if (-not (Test-Path $GsonJar)) {
    throw "Missing Gson jar: $GsonJar"
}

if (-not (Test-Path $NeoForgeJarDependency)) {
    throw "Missing NeoForge jar: $NeoForgeJarDependency"
}

if (-not (Test-Path $NeoForgeLoaderJar)) {
    throw "Missing NeoForge loader jar: $NeoForgeLoaderJar"
}

if (-not (Test-Path $NeoForgeBusJar)) {
    throw "Missing NeoForge bus jar: $NeoForgeBusJar"
}

if (-not (Test-Path $NeoForgeApiJar)) {
    throw "Missing NeoForge API jar: $NeoForgeApiJar"
}

Remove-Item $BuildDir -Recurse -Force -ErrorAction Ignore
New-Item -ItemType Directory -Force -Path $ClassesDir | Out-Null
New-Item -ItemType Directory -Force -Path $FabricStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $NeoForgeStageDir | Out-Null

$SourceFiles = Get-ChildItem -Path (Join-Path $ProjectRoot "src\\main\\java") -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
$Classpath = "$FabricLoaderJar;$GsonJar;$NeoForgeJarDependency;$NeoForgeLoaderJar;$NeoForgeBusJar;$NeoForgeApiJar"

javac -encoding UTF-8 -cp $Classpath -d $ClassesDir $SourceFiles
if ($LASTEXITCODE -ne 0) {
    throw "javac failed with exit code $LASTEXITCODE"
}

Copy-Item -Path (Join-Path $ClassesDir "*") -Destination $FabricStageDir -Recurse -Force
Copy-Item -Path (Join-Path $ClassesDir "*") -Destination $NeoForgeStageDir -Recurse -Force

$FabricResourcesDir = Join-Path $ProjectRoot "src\\main\\resources"
if (Test-Path $FabricResourcesDir) {
    Copy-Item -Path (Join-Path $FabricResourcesDir "*") -Destination $FabricStageDir -Recurse -Force
}

$NeoForgeResourcesDir = Join-Path $ProjectRoot "src\\neoforge\\resources"
if (Test-Path $NeoForgeResourcesDir) {
    Copy-Item -Path (Join-Path $NeoForgeResourcesDir "*") -Destination $NeoForgeStageDir -Recurse -Force
}

foreach ($pair in @(
    @{ Jar = $FabricJar; Stage = $FabricStageDir; Install = $FabricInstallDir },
    @{ Jar = $NeoForgeJar; Stage = $NeoForgeStageDir; Install = $NeoForgeInstallDir }
)) {
    $ZipPath = "$($pair.Jar).zip"
    if (Test-Path $ZipPath) {
        Remove-Item $ZipPath -Force
    }
    Compress-Archive -Path (Join-Path $pair.Stage "*") -DestinationPath $ZipPath
    Move-Item -Force $ZipPath $pair.Jar

    New-Item -ItemType Directory -Force -Path $pair.Install | Out-Null
    Get-ChildItem -Path $pair.Install -Filter 'codex-client-control*.jar' -ErrorAction Ignore | Remove-Item -Force
    Copy-Item -Force $pair.Jar -Destination $pair.Install

    Write-Host "Built: $($pair.Jar)"
    Write-Host "Installed to: $($pair.Install)"
}
