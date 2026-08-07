#Requires -Version 5.1
<#
.SYNOPSIS
    生成 Windows 发布 zip 包。

.DESCRIPTION
    本脚本复用 build_exe.ps1 产出的 dist/win-unpacked 目录。
    build_exe.ps1 已保证：
    - 工作区未被 git 跟踪的文件不会进入发布目录。
    - 工作区被 git 跟踪的文件都会进入发布目录。

    本脚本只负责：
    1. 调用 build_exe.ps1。
    2. 将 dist/win-unpacked 压缩为 zip。
#>

param(
    [Parameter(Mandatory = $false)]
    [string]$OutputName = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step {
    <#
    .SYNOPSIS
        写出统一格式的阶段日志。
    .PARAMETER Message
        日志文本。
    .PARAMETER Color
        控制台颜色。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $false)]
        [string]$Color = "Cyan"
    )

    Write-Host $Message -ForegroundColor $Color
}

function Get-ProjectRoot {
    <#
    .SYNOPSIS
        获取项目根目录。
    .OUTPUTS
        System.String
    #>
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-SevenZipPath {
    <#
    .SYNOPSIS
        查找 7-Zip 可执行文件。
    .DESCRIPTION
        优先使用 7-Zip，因为它在大量文件压缩场景下明显快于 Compress-Archive。
    .OUTPUTS
        System.String
    #>
    $candidates = @(
        "${env:ProgramFiles}\7-Zip\7z.exe",
        "${env:ProgramFiles(x86)}\7-Zip\7z.exe",
        "${env:ProgramW6432}\7-Zip\7z.exe"
    )

    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }

    return $null
}

function Invoke-BuildRelease {
    <#
    .SYNOPSIS
        调用 build_exe.ps1 构建发布目录。
    .PARAMETER ProjectRoot
        项目根目录。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $buildScript = Join-Path $ProjectRoot "scripts\win\build_exe.ps1"
    if (-not (Test-Path -LiteralPath $buildScript)) {
        throw "缺少构建脚本: $buildScript"
    }

    & $buildScript
    if ($LASTEXITCODE -ne 0) {
        throw "build_exe.ps1 执行失败"
    }
}

function Compress-ReleaseDirectory {
    <#
    .SYNOPSIS
        压缩发布目录。
    .DESCRIPTION
        直接压缩 dist/win-unpacked，避免再复制一份发布目录，减少大量小文件二次复制。
    .PARAMETER ReleaseRoot
        发布目录。
    .PARAMETER OutputFile
        输出 zip 文件路径。
    .PARAMETER SevenZipPath
        7-Zip 路径。为空时回退到 Compress-Archive。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot,

        [Parameter(Mandatory = $true)]
        [string]$OutputFile,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$SevenZipPath
    )

    if (Test-Path -LiteralPath $OutputFile) {
        Remove-Item -LiteralPath $OutputFile -Force
    }

    if ($SevenZipPath) {
        & $SevenZipPath a -tzip -mx=5 $OutputFile "$ReleaseRoot\*"
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip 压缩失败"
        }
        return
    }

    Compress-Archive -Path "$ReleaseRoot\*" -DestinationPath $OutputFile -Force
}

function Main {
    <#
    .SYNOPSIS
        主执行流程。
    #>
    $projectRoot = Get-ProjectRoot
    $distDir = Join-Path $projectRoot "dist"
    $releaseRoot = Join-Path $distDir "win-unpacked"
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $resolvedOutputName = if ([string]::IsNullOrWhiteSpace($OutputName)) { "agent-society-$timestamp" } else { $OutputName }
    $outputFile = Join-Path $distDir "$resolvedOutputName.zip"
    $sevenZipPath = Get-SevenZipPath

    Write-Step "========== pack.ps1 启动 ==========" "Green"
    Write-Step "[1/3] 构建发布目录..."
    Invoke-BuildRelease -ProjectRoot $projectRoot

    if (-not (Test-Path -LiteralPath $releaseRoot)) {
        throw "发布目录不存在: $releaseRoot"
    }

    Write-Step "[2/3] 压缩发布目录..."
    if ($sevenZipPath) {
        Write-Host "  - 使用 7-Zip: $sevenZipPath"
    } else {
        Write-Host "  - 未找到 7-Zip，回退到 Compress-Archive"
    }
    Compress-ReleaseDirectory -ReleaseRoot $releaseRoot -OutputFile $outputFile -SevenZipPath $sevenZipPath

    Write-Step "[3/3] 输出结果..." "Green"
    $zipInfo = Get-Item -LiteralPath $outputFile
    Write-Host "Output File: $($zipInfo.FullName)"
    Write-Host ("File Size: {0:N2} MB" -f ($zipInfo.Length / 1MB))
}

Main
