param(
    [Parameter(Mandatory = $true)]
    [string]$SourceJarPath,
    [string]$OutputJarPath = $SourceJarPath,
    [string]$MinecraftVersion = '1.21.11',
    [string]$ResolvedVersion = '1.1.0+1.21.11',
    [string]$ProjectRoot = '',
    [string]$CommonClassesDir = '',
    [string]$TomlTemplatePath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Resolve-JarToolPath {
    $candidates = @()

    if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        $candidates += (Join-Path $env:JAVA_HOME 'bin\jar.exe')
    }

    $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($null -ne $javaCommand) {
        $javaDir = Split-Path -Parent $javaCommand.Source
        $candidates += (Join-Path $javaDir 'jar.exe')
    }

    $candidates += @(
        'C:\Program Files\Java\jdk-21\bin\jar.exe',
        'C:\Program Files\Java\jdk-17\bin\jar.exe'
    )

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    $jarCommand = Get-Command jar.exe -ErrorAction SilentlyContinue
    if ($null -ne $jarCommand) {
        return $jarCommand.Source
    }

    throw 'Unable to locate jar.exe. Please install JDK 17+ or set JAVA_HOME.'
}

if ([string]::IsNullOrWhiteSpace($CommonClassesDir)) {
    $CommonClassesDir = Join-Path $ProjectRoot "common\\build\\$MinecraftVersion\\classes\\java\\main"
}

if ([string]::IsNullOrWhiteSpace($TomlTemplatePath)) {
    $TomlTemplatePath = Join-Path $ProjectRoot 'neoforge\src\main\resources\META-INF\neoforge.mods.toml'
}

if (-not (Test-Path $SourceJarPath)) {
    throw "Source jar not found: $SourceJarPath"
}

if (-not (Test-Path $CommonClassesDir)) {
    throw "Common classes directory not found: $CommonClassesDir"
}

if (-not (Test-Path $TomlTemplatePath)) {
    throw "NeoForge TOML template not found: $TomlTemplatePath"
}

$tempRoot = Join-Path $ProjectRoot ("build\\tmp\\repair-neoforge-jar-" + [System.Guid]::NewGuid().ToString('N'))
$tempManifestPath = Join-Path $ProjectRoot ("build\\tmp\\repair-neoforge-manifest-" + [System.Guid]::NewGuid().ToString('N') + '.mf')

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    [System.IO.Compression.ZipFile]::ExtractToDirectory($SourceJarPath, $tempRoot)

    Copy-Item -Path (Join-Path $CommonClassesDir '*') -Destination $tempRoot -Recurse -Force

    $tomlContent = Get-Content -Raw -Path $TomlTemplatePath
    $tomlContent = $tomlContent.Replace('${version}', $ResolvedVersion)
    $tomlContent = $tomlContent.Replace('${minecraft_version}', $MinecraftVersion)

    $metaInfDir = Join-Path $tempRoot 'META-INF'
    if (-not (Test-Path $metaInfDir)) {
        New-Item -ItemType Directory -Path $metaInfDir -Force | Out-Null
    }

    $manifestInTreePath = Join-Path $metaInfDir 'MANIFEST.MF'
    if (Test-Path $manifestInTreePath) {
        Remove-Item -Force $manifestInTreePath
    }

    $manifestContent = @(
        'Manifest-Version: 1.0'
        "Implementation-Version: $ResolvedVersion"
        'FMLModType: MOD'
        ''
    ) -join "`r`n"

    $ascii = [System.Text.Encoding]::ASCII
    [System.IO.File]::WriteAllText($tempManifestPath, $manifestContent, $ascii)

    $tomlPath = Join-Path $tempRoot 'META-INF\neoforge.mods.toml'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tomlPath, $tomlContent, $utf8NoBom)

    $licenseSourcePath = Join-Path $ProjectRoot 'LICENSE'
    $licenseTargetPath = Join-Path $tempRoot 'LICENSE_codex-client-control-neoforge'
    if (Test-Path $licenseSourcePath) {
        Copy-Item -Path $licenseSourcePath -Destination $licenseTargetPath -Force
    }

    $outputDir = Split-Path -Parent $OutputJarPath
    if ($outputDir -and -not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }

    if (Test-Path $OutputJarPath) {
        Remove-Item -Force $OutputJarPath
    }

    $jarToolPath = Resolve-JarToolPath
    & $jarToolPath --create --file $OutputJarPath --manifest $tempManifestPath -C $tempRoot .
    if ($LASTEXITCODE -ne 0) {
        throw "jar.exe failed with exit code $LASTEXITCODE"
    }

    $archive = [System.IO.Compression.ZipFile]::OpenRead($OutputJarPath)
    try {
        $entry = $archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -eq 'META-INF/neoforge.mods.toml'
        } | Select-Object -First 1
        if ($null -eq $entry) {
            throw 'Missing META-INF/neoforge.mods.toml in rebuilt jar.'
        }

        $manifestEntry = $archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -eq 'META-INF/MANIFEST.MF'
        } | Select-Object -First 1
        if ($null -eq $manifestEntry) {
            throw 'Missing META-INF/MANIFEST.MF in rebuilt jar.'
        }

        $stream = $entry.Open()
        try {
            $firstBytes = New-Object byte[] 3
            $byteCount = $stream.Read($firstBytes, 0, 3)
        } finally {
            $stream.Dispose()
        }

        if (
            $byteCount -eq 3 -and
            $firstBytes[0] -eq 0xEF -and
            $firstBytes[1] -eq 0xBB -and
            $firstBytes[2] -eq 0xBF
        ) {
            throw 'Rebuilt jar still contains a UTF-8 BOM in neoforge.mods.toml.'
        }
    } finally {
        $archive.Dispose()
    }

    Write-Output "Rebuilt NeoForge jar: $OutputJarPath"
} finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempManifestPath) {
        Remove-Item -Force $tempManifestPath -ErrorAction SilentlyContinue
    }
}
