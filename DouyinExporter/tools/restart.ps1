# 关掉正在跑的「抖音聊天记录导出器」，再按它原来的运行方式重新打开。
# 打包版（DouyinExporter.exe）和源码版（pythonw app.py）都认。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File DouyinExporter/tools/restart.ps1
#   ... 加 -DryRun 只列出「会关哪些进程」，什么都不杀、什么都不开
#
# 为什么要这么绕：导出器是多进程的（外壳 python + WebView2 子进程一堆），
# 只杀外壳会留下占着 Data\ 目录锁的 webview2，重开就白屏（README 故障排查第一条）。
param([switch]$DryRun)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot          # .../DouyinExporter
Write-Host "项目目录：$root"

# ---- 1) 先拿全量进程表，建 pid→父pid 的映射（后面顺着 webview2 往上找外壳）----
$all = @(Get-CimInstance Win32_Process)
$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }

function Get-OwnerOf([int]$pid0) {
  # 从某个 webview2 进程往上走进程树，找到第一个 python / pythonw / 导出器 exe
  $cur = $pid0
  for ($i = 0; $i -lt 12; $i++) {
    $p = $byPid[[int]$cur]
    if (-not $p) { return $null }
    if ($p.Name -match '^(python|pythonw|DouyinExporter)\.(exe|EXE)$') { return $p }
    $cur = $p.ParentProcessId
    if (-not $cur -or -not $byPid[[int]$cur]) { return $null }
  }
  return $null
}

$targets = @{}
function Add-Target($p, $why) {
  if ($p) { $targets[[int]$p.ProcessId] = @{ proc = $p; why = $why } }
}

# a) 打包版进程
foreach ($p in $all) { if ($p.Name -eq 'DouyinExporter.exe') { Add-Target $p 'DouyinExporter.exe' } }

# b) 源码版：可执行文件在本项目 .venv 里、命令行跑 app.py
foreach ($p in $all) {
  if ($p.Name -match '^(python|pythonw)\.exe$' -and $p.CommandLine -match 'app\.py') {
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      Add-Target $p '本项目 .venv 里跑的 app.py'
    }
  }
}

# c) 兜底：谁的 WebView2 子进程带着本项目 Data\ 路径，它就是导出器
#    （覆盖「用系统 Python 直接 app.py」——命令行里根本看不出目录）
$dataPath = ($root + '\Data').ToLower()
foreach ($p in $all) {
  if ($p.Name -ne 'msedgewebview2.exe') { continue }
  $cl = $p.CommandLine
  if (-not $cl) { continue }
  if ($cl.ToLower().Contains($dataPath)) {
    $owner = Get-OwnerOf ([int]$p.ProcessId)
    if ($owner) { Add-Target $owner ('它的 WebView2 用的是本项目 Data\') }
  }
}

if ($targets.Count -eq 0) {
  Write-Host '没发现在跑的导出器实例，直接开一个新的。'
} else {
  Write-Host ("要关的进程 {0} 个：" -f $targets.Count)
  foreach ($k in ($targets.Keys | Sort-Object)) {
    $t = $targets[$k]
    Write-Host ("  pid={0} {1} :: {2}" -f $k, $t.proc.Name, $t.why)
  }
}

# 连 webview2 子进程一起收：只杀外壳会留下占锁的僵尸
$webviews = @($all | Where-Object {
  $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($dataPath)
})

if ($DryRun) {
  Write-Host ("DryRun：本次不杀任何进程（另检测到本项目 WebView2 子进程 {0} 个），也不启动。" -f $webviews.Count)
  return
}

foreach ($k in ($targets.Keys | Sort-Object)) {
  Stop-Process -Id $k -Force
}
foreach ($w in $webviews) { Stop-Process -Id $w.ProcessId -Force }

# 等进程真退出再开：Data\ 的 WebView2 锁释放需要一点时间
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 300
  $left = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'DouyinExporter.exe') -or
    ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($dataPath)) -or
    ($targets.ContainsKey([int]$_.ProcessId))
  })
  if ($left.Count -eq 0) { break }
}

# ---- 2) 重新打开：原来跑的是 exe 就开 exe，否则走源码（pythonw 不弹控制台窗口）----
$hadExe = $false
foreach ($k in $targets.Keys) { if ($targets[$k].proc.Name -eq 'DouyinExporter.exe') { $hadExe = $true } }
$exePath = Join-Path $root 'DouyinExporter.exe'
$venvPy = Join-Path $root '.venv\Scripts\pythonw.exe'

if ($hadExe -and (Test-Path $exePath)) {
  Start-Process -FilePath $exePath -WorkingDirectory $root
  Write-Host "已重新打开：$exePath"
} elseif (Test-Path $venvPy) {
  Start-Process -FilePath $venvPy -ArgumentList 'app.py' -WorkingDirectory $root
  Write-Host "已重新打开：pythonw app.py（源码版）"
} elseif (Test-Path (Join-Path $root '启动.bat')) {
  Start-Process -FilePath (Join-Path $root '启动.bat') -WorkingDirectory $root
  Write-Host "已重新打开：启动.bat（没找到 .venv，交给它自己装依赖）"
} else {
  Write-Host '找不到可执行入口（既没有 DouyinExporter.exe 也没有 启动.bat），请手动启动。'
  exit 1
}

Start-Sleep -Seconds 2
$up = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'DouyinExporter.exe' -or ($_.Name -match '^(python|pythonw)\.exe$' -and $_.CommandLine -match 'app\.py')
})
Write-Host ("当前在跑的导出器进程 {0} 个。首次启动解压 / 登录检测要等几秒。" -f $up.Count)
