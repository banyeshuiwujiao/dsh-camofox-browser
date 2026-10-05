<#
.SYNOPSIS
  dsh-camofox-browser 一键安装：装好后端（camofox-browser + Camoufox 引擎）并注册 DSH 插件。

.DESCRIPTION
  幂等：每一步都先检查现状，已经好的就跳过。加上 -SkipEngine 可以只要后端、
  不碰 500MB 的浏览器引擎。

  为什么需要这个脚本：装这个工具有四个坑，只看 README 很容易踩。
    1. npm 的全局 proxy 配置会让国内镜像也绕一圈代理（本机实测 npm ping 9.87s vs 直连 0.53s）；
    2. better-sqlite3 在 Windows 上会触发 node-gyp 编译，而它只被单元测试引用；
    3. camoufox-js 用内置 fetch，默认**不读** HTTP(S)_PROXY，下引擎会静默超时；
    4. 引擎目录变量是 CAMOUFOX_INSTALL_DIR（含 U），和 camofox-browser 自己的
       CAMOFOX_ 前缀不是一套；写错不报错，直接静默重下 500MB。

.PARAMETER ServerDir
  camofox-browser 的落地目录。

.PARAMETER Proxy
  下载引擎时用的代理，如 http://127.0.0.1:7897。留空则直连。

.PARAMETER SkipEngine
  跳过 Camoufox 引擎下载（已经装过、或想稍后再装）。

.PARAMETER SkipPlugin
  只装后端，不注册 DSH 插件。

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Proxy http://127.0.0.1:7897
#>
[CmdletBinding()]
param(
  [string]$ServerDir = 'E:\development\camofox-browser',
  [string]$Proxy = '',
  [string]$PluginDir = $PSScriptRoot,
  [switch]$SkipEngine,
  [switch]$SkipPlugin
)

$ErrorActionPreference = 'Stop'
function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    ok  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !!  $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0. 前置检查
Step 0 '检查前置'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '找不到 node。camofox-browser 要求 Node >= 22。' }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 22) { throw "Node 版本过低：$(node -v)，要求 >= 22。" }
Ok "node $(node -v)"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '找不到 git。' }
Ok 'git 可用'

# npm 全局 proxy 会让国内镜像绕道代理。用命令行参数压掉，不动用户的 .npmrc。
$npmBase = @('--registry=https://registry.npmmirror.com', '--proxy=false', '--https-proxy=false')

# ------------------------------------------------------- 1. camofox-browser
Step 1 "后端源码：$ServerDir"
if (Test-Path (Join-Path $ServerDir 'server.js')) {
  Ok '已存在，跳过 clone'
} else {
  $parent = Split-Path $ServerDir -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  git clone --depth 1 https://github.com/jo-inc/camofox-browser $ServerDir
  if ($LASTEXITCODE -ne 0) { throw 'git clone 失败。' }
  Ok 'clone 完成'
}

Step 2 '安装依赖（跳过 better-sqlite3 编译）'
Push-Location $ServerDir
try {
  # --ignore-scripts：better-sqlite3 只被 tests/ 引用，生产代码零引用，
  # 而它会在 Windows 上触发 node-gyp。--omit=dev 顺带甩掉 openclaw/jest/typescript。
  & npm install --omit=dev --ignore-scripts --no-audit --no-fund @npmBase 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { throw 'npm install 失败。' }
  node --input-type=module -e "await import('camoufox-js/dist/addons.js'); await import('playwright-core'); await import('express');" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '核心依赖 import 失败，node_modules 可能不完整。' }
  Ok '依赖就绪（camoufox-js / playwright-core / express 均可 import）'

  # ------------------------------------------------------ 3. Camoufox 引擎
  Step 3 'Camoufox 引擎（约 500MB）'
  $cache = Join-Path $env:LOCALAPPDATA 'camoufox\camoufox\Cache'
  if ($SkipEngine) {
    Warn '-SkipEngine：跳过'
  } elseif (Test-Path (Join-Path $cache 'version.json')) {
    Ok "已装：$(Get-Content (Join-Path $cache 'version.json') -Raw)"
  } else {
    if ($Proxy) {
      $env:HTTPS_PROXY = $Proxy; $env:HTTP_PROXY = $Proxy
      # 关键：camoufox-js 用 Node 内置 fetch，不读 HTTP(S)_PROXY；Node 24 需要这个开关。
      $env:NODE_USE_ENV_PROXY = '1'
      Ok "走代理 $Proxy"
    } else {
      Warn '未指定 -Proxy，直连 GitHub（国内通常很慢或超时；建议 -Proxy http://127.0.0.1:7897）'
    }
    Warn '不要设置 CAMOFOX_INSTALL_DIR（无 U）来改位置 —— 那是错的变量名，会导致静默重下。'
    node lib/camoufox-download.js
    if ($LASTEXITCODE -ne 0) { throw '引擎下载失败。' }
    if (-not (Test-Path (Join-Path $cache 'version.json'))) { throw "引擎没有落到预期位置：$cache" }
    Ok '引擎安装完成'
  }
} finally {
  Pop-Location
}

# ------------------------------------------------------------- 4. DSH 插件
Step 4 '注册 DSH 插件'
if ($SkipPlugin) {
  Warn '-SkipPlugin：跳过'
} else {
  $dsh = 'E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (-not (Test-Path $dsh)) {
    Warn "没找到应用自带 CLI（$dsh）。手动装：dsh plugin --profile desktop add link:$PluginDir"
  } else {
    & $dsh plugin --profile desktop add "link:$PluginDir" 2>&1 | Select-Object -Last 4
    if ($LASTEXITCODE -ne 0) { throw 'DSH 插件注册失败。' }
    Ok '插件已注册（宿主半边热生效，无需重启）'
  }
}

# ------------------------------------------------------------------ 5. 自检
Step 5 '自检'
Push-Location $PluginDir
try {
  node test/smoke.mjs 2>&1 | Select-Object -Last 1
  Ok '插件自测通过'
} catch {
  Warn "插件自测失败：$($_.Exception.Message)"
} finally {
  Pop-Location
}

Write-Host "`n完成。首次调用 camofox 工具时插件会自动拉起后端服务（冷启动 3-8 秒）。" -ForegroundColor Green
Write-Host "验证：camofox {action:`"open`", url:`"https://example.com`"}" -ForegroundColor Gray
