$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir = Join-Path $ProjectRoot "build"
$ClassesDir = Join-Path $BuildDir "classes"
$StageDir = Join-Path $BuildDir "stage"
$OutputJar = Join-Path $BuildDir "codex-client-control-1.0.0+1.21.11.jar"
$InstallDir = Join-Path $ProjectRoot "..\\versions\\1.21.11far\\mods"

$LoaderJar = Join-Path $ProjectRoot "..\\libraries\\net\\fabricmc\\fabric-loader\\0.18.4\\fabric-loader-0.18.4.jar"
$GsonJar = Join-Path $ProjectRoot "..\\libraries\\com\\google\\code\\gson\\gson\\2.13.2\\gson-2.13.2.jar"

if (-not (Test-Path $LoaderJar)) {
    throw "Missing Fabric Loader jar: $LoaderJar"
}

if (-not (Test-Path $GsonJar)) {
    throw "Missing Gson jar: $GsonJar"
}

Remove-Item $BuildDir -Recurse -Force -ErrorAction Ignore
New-Item -ItemType Directory -Force -Path $ClassesDir | Out-Null
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$SourceFiles = Get-ChildItem -Path (Join-Path $ProjectRoot "src\\main\\java") -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
$Classpath = "$LoaderJar;$GsonJar"

javac -encoding UTF-8 -cp $Classpath -d $ClassesDir $SourceFiles
if ($LASTEXITCODE -ne 0) {
    throw "javac failed with exit code $LASTEXITCODE"
}

Copy-Item -Path (Join-Path $ProjectRoot "src\\main\\resources\\*") -Destination $StageDir -Recurse -Force
Copy-Item -Path (Join-Path $ClassesDir "*") -Destination $StageDir -Recurse -Force

$ZipPath = "$OutputJar.zip"
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath
Move-Item -Force $ZipPath $OutputJar

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $OutputJar -Destination $InstallDir

Write-Host "Built: $OutputJar"
Write-Host "Installed to: $InstallDir"
