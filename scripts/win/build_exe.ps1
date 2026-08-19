#Requires -Version 5.1
<#
.SYNOPSIS
    构建 Windows 可执行发布目录。

.DESCRIPTION
    本脚本采用“方案 1”：
    1. 先用 bun 编译生成 agent-society.exe。
    2. 再把当前工作区中所有由 git 跟踪的文件复制到发布目录。
    3. 明确排除未被 git 跟踪的工作区文件。
    4. 仅额外加入发布所需的构建产物，例如 exe 和 ffmpeg.exe。

    这样可以同时满足两个约束：
    - 未被 git 跟踪的文件不进入发布包。
    - 所有被 git 跟踪的文件都进入发布包。
#>

param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step {
    <#
    .SYNOPSIS
        写出统一格式的阶段日志。
    .DESCRIPTION
        让打包流程中的关键阶段容易定位，异常时也便于直接查看终端输出。
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

function Assert-CommandExists {
    <#
    .SYNOPSIS
        断言指定命令存在。
    .DESCRIPTION
        在真正执行构建前尽早失败，避免中途才发现缺少依赖。
    .PARAMETER CommandName
        要检测的命令名。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "缺少必需命令: $CommandName"
    }
}

function Remove-DirectoryWithRetry {
    <#
    .SYNOPSIS
        带重试删除目录。
    .DESCRIPTION
        Windows 上偶发存在索引器、杀毒软件、压缩软件短时间占用文件句柄的情况。
        这里增加有限重试，避免因为瞬时占用导致整个打包流程失败。
    .PARAMETER DirectoryPath
        要删除的目录路径。
    .PARAMETER MaxAttempts
        最大尝试次数。
    .PARAMETER DelayMilliseconds
        每次重试之间的等待时间。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$DirectoryPath,

        [Parameter(Mandatory = $false)]
        [int]$MaxAttempts = 5,

        [Parameter(Mandatory = $false)]
        [int]$DelayMilliseconds = 1000
    )

    if (-not (Test-Path -LiteralPath $DirectoryPath)) {
        return
    }

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $DirectoryPath -Recurse -Force
            return
        }
        catch {
            if ($attempt -ge $MaxAttempts) {
                throw
            }

            Write-Warning ("删除目录失败，准备重试。attempt={0}/{1} path={2} error={3}" -f $attempt, $MaxAttempts, $DirectoryPath, $_.Exception.Message)
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
}

function Get-ProjectRoot {
    <#
    .SYNOPSIS
        获取项目根目录。
    .DESCRIPTION
        脚本可能从任意当前目录调用，统一以脚本相对路径定位工程根目录。
    .OUTPUTS
        System.String
    #>
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-GitTrackedFiles {
    <#
    .SYNOPSIS
        获取当前工作区中所有由 git 跟踪的文件列表。
    .DESCRIPTION
        发布内容以 git 跟踪状态为准，避免把本地临时文件、缓存文件、私有配置打进包。
    .PARAMETER ProjectRoot
        项目根目录。
    .OUTPUTS
        System.String[]
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    Push-Location $ProjectRoot
    try {
        $files = & git -c core.quotepath=false ls-files
        if ($LASTEXITCODE -ne 0) {
            throw "git ls-files 执行失败"
        }

        return @($files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    finally {
        Pop-Location
    }
}

function Should-IncludeTrackedFile {
    <#
    .SYNOPSIS
        判断 git 跟踪文件是否应该进入发布目录。
    .DESCRIPTION
        默认规则是“git 跟踪文件全部进入包”，但用户已明确要求以下内容不进入发布包：
        - docs/ 与 runtime/(开发文档与开发期运行目录);
        - agent-society-data*(运行时数据目录,含 -3001 等变体);
        - config/(本地配置目录,发布包不携带任何配置);
        - 所有句点开头的顶层条目(文件夹与文件,.agents/.claude/.github/.trae/.vscode/.gitignore 等)。
        这里将该约束集中在一个函数里，避免散落在复制流程中。
    .PARAMETER RelativePath
        相对于项目根目录的 git 跟踪文件路径。
    .OUTPUTS
        System.Boolean
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $normalizedPath = $RelativePath.Replace('\', '/')
    if ($normalizedPath.StartsWith('docs/')) {
        return $false
    }
    if ($normalizedPath.StartsWith('runtime/')) {
        return $false
    }
    if ($normalizedPath.StartsWith('agent-society-data')) {
        return $false
    }
    if ($normalizedPath.StartsWith('config/')) {
        return $false
    }
    if ($normalizedPath.Split('/')[0].StartsWith('.')) {
        return $false
    }

    return $true
}

function Copy-GitTrackedFilesToRelease {
    <#
    .SYNOPSIS
        复制所有 git 跟踪文件到发布目录。
    .DESCRIPTION
        严格按 git 跟踪状态构建发布目录，不引入未跟踪文件。
    .PARAMETER ProjectRoot
        项目根目录。
    .PARAMETER DestinationRoot
        发布目录根路径。
    .PARAMETER TrackedFiles
        相对路径列表。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$TrackedFiles
    )

    foreach ($relativePath in $TrackedFiles) {
        if (-not (Should-IncludeTrackedFile -RelativePath $relativePath)) {
            continue
        }

        $sourcePath = Join-Path $ProjectRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            throw "git 跟踪文件不存在，无法继续打包: $relativePath"
        }

        $destinationPath = Join-Path $DestinationRoot $relativePath
        $destinationDir = Split-Path -Parent $destinationPath
        if (-not [string]::IsNullOrEmpty($destinationDir) -and -not (Test-Path -LiteralPath $destinationDir)) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }

        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }
}

function Copy-BuildArtifactsToRelease {
    <#
    .SYNOPSIS
        复制构建产物到发布目录根目录。
    .DESCRIPTION
        这些文件不是 git 跟踪文件，但属于本次发布必须附带的产物。
    .PARAMETER ProjectRoot
        项目根目录。
    .PARAMETER ReleaseRoot
        发布目录根路径。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    $artifactMap = @(
        @{
            Source = Join-Path $ReleaseRoot "agent-society.exe"
            Target = Join-Path $ReleaseRoot "agent-society.exe"
            Required = $true
        },
        @{
            Source = Join-Path $ProjectRoot "node_modules\ffmpeg-static\ffmpeg.exe"
            Target = Join-Path $ReleaseRoot "ffmpeg.exe"
            Required = $false
        }
    )

    foreach ($artifact in $artifactMap) {
        $sourcePath = [string]$artifact.Source
        $targetPath = [string]$artifact.Target
        $required = [bool]$artifact.Required

        if (-not (Test-Path -LiteralPath $sourcePath)) {
            if ($required) {
                throw "缺少必需构建产物: $sourcePath"
            }

            Write-Warning "可选产物不存在，已跳过: $sourcePath"
            continue
        }

        if ($sourcePath -ne $targetPath) {
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        }
    }
}

function Remove-TransientArtifacts {
    <#
    .SYNOPSIS
        删除不应进入发布目录的临时构建副产物。
    .DESCRIPTION
        source map 不是发布运行的必要文件，同时它也不满足“git 跟踪文件”约束。
    .PARAMETER ReleaseRoot
        发布目录根路径。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseRoot
    )

    $transientFiles = @(
        (Join-Path $ReleaseRoot "start.js.map")
    )

    foreach ($filePath in $transientFiles) {
        if (Test-Path -LiteralPath $filePath) {
            Remove-Item -LiteralPath $filePath -Force
        }
    }
}

function Main {
    <#
    .SYNOPSIS
        主执行流程。
    .DESCRIPTION
        集中组织构建顺序，保证发布目录先清理、再编译、再复制 git 跟踪文件、最后附加构建产物。
    #>
    $projectRoot = Get-ProjectRoot
    $distDir = Join-Path $projectRoot "dist"
    $releaseRoot = Join-Path $distDir "win-unpacked"
    $exePath = Join-Path $releaseRoot "agent-society.exe"

    Write-Step "Building Agent Society for Windows..." "Green"

    Assert-CommandExists "bun"
    Assert-CommandExists "git"

    Write-Step "Cleaning dist directory..."
    if (Test-Path -LiteralPath $releaseRoot) {
        Remove-DirectoryWithRetry -DirectoryPath $releaseRoot
    }
    if (-not (Test-Path -LiteralPath $distDir)) {
        New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

    Write-Step "Compiling executable..."
    Push-Location $projectRoot
    try {
        & bun build --compile --minify --sourcemap ./start.js --outfile $exePath
        if ($LASTEXITCODE -ne 0) {
            throw "bun build 编译失败"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "编译完成后未找到可执行文件: $exePath"
    }

    Write-Step "Collecting git-tracked files..."
    $trackedFiles = Get-GitTrackedFiles -ProjectRoot $projectRoot
    $releaseTrackedFiles = @($trackedFiles | Where-Object { Should-IncludeTrackedFile -RelativePath $_ })
    Write-Host ("  - git tracked files: {0}" -f $trackedFiles.Count)
    Write-Host ("  - release tracked files after exclusions: {0}" -f $releaseTrackedFiles.Count)

    Write-Step "Copying git-tracked files..."
    Copy-GitTrackedFilesToRelease -ProjectRoot $projectRoot -DestinationRoot $releaseRoot -TrackedFiles $releaseTrackedFiles

    Write-Step "Copying build artifacts..."
    Copy-BuildArtifactsToRelease -ProjectRoot $projectRoot -ReleaseRoot $releaseRoot

    Write-Step "Removing transient artifacts..."
    Remove-TransientArtifacts -ReleaseRoot $releaseRoot

    Write-Step "Build Complete!" "Green"
    Write-Host "Output Directory: $releaseRoot"
    Write-Host "You can now package or test '$exePath'."
}

Main
