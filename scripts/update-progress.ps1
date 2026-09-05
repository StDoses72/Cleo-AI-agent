param([Parameter(Mandatory = $true)][string]$StatusPath)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$attentionPath = Join-Path (Split-Path -Parent $StatusPath) "attention"
$script:lastAttention = ""
$script:terminal = $false
$script:result = $null
$script:completedAt = $null
$operationId = ([System.IO.File]::ReadAllText($StatusPath) | ConvertFrom-Json).operationId

$form = New-Object System.Windows.Forms.Form
$form.Text = "Cleo 更新"
$form.Size = New-Object System.Drawing.Size(500, 260)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$heading = New-Object System.Windows.Forms.Label
$heading.Location = New-Object System.Drawing.Point(24, 20)
$heading.Size = New-Object System.Drawing.Size(440, 32)
$heading.Text = "正在准备更新…"
$form.Controls.Add($heading)
$detail = New-Object System.Windows.Forms.TextBox
$detail.Multiline = $true
$detail.ReadOnly = $true
$detail.BorderStyle = "None"
$detail.ScrollBars = "Vertical"
$detail.BackColor = $form.BackColor
$detail.Location = New-Object System.Drawing.Point(24, 60)
$detail.Size = New-Object System.Drawing.Size(440, 64)
$detail.Text = "此窗口会显示安装进度，完成后自动打开 Cleo。"
$form.Controls.Add($detail)
$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(24, 132)
$progress.Size = New-Object System.Drawing.Size(440, 16)
$progress.Style = "Marquee"
$form.Controls.Add($progress)
$openButton = New-Object System.Windows.Forms.Button
$openButton.Location = New-Object System.Drawing.Point(230, 172)
$openButton.Size = New-Object System.Drawing.Size(112, 32)
$openButton.Text = "打开 Cleo"
$openButton.Visible = $false
$openButton.Add_Click({
    $exe = Join-Path $script:result.installRoot "Cleo.exe"
    if (Test-Path -LiteralPath $exe) {
        Start-Process -FilePath $exe -WorkingDirectory $script:result.installRoot
        $form.Close()
    }
})
$form.Controls.Add($openButton)
$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Location = New-Object System.Drawing.Point(352, 172)
$closeButton.Size = New-Object System.Drawing.Size(112, 32)
$closeButton.Text = "最小化"
$closeButton.Add_Click({
    if ($script:terminal) { $form.Close() } else { $form.WindowState = "Minimized" }
})
$form.Controls.Add($closeButton)
$form.Add_FormClosing({
    if (-not $script:terminal) {
        $_.Cancel = $true
        $form.WindowState = "Minimized"
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
    try {
        # Permit the installer to atomically replace the status while this window reads it.
        $stream = [System.IO.File]::Open($StatusPath, "Open", "Read", "ReadWrite, Delete")
        $reader = New-Object System.IO.StreamReader($stream)
        try { $state = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($state.operationId -ne $operationId) {
            $script:terminal = $true
            $form.Close()
            return
        }
        $script:result = $state
        $owner = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
        if ($state.phase -notin @("completed", "failed") -and
            (-not $owner -or ($state.processStartTime -and
                $owner.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.processStartTime))) {
            $state.phase = "failed"
            $state.error = "更新进程意外退出。请打开 Cleo 后重新检查更新。"
        }
        $script:terminal = $state.phase -in @("completed", "failed")
        $heading.Text = switch ($state.phase) {
            "starting" { "正在启动更新程序…" }
            "verifying" { "1 / 4  正在校验安装包…" }
            "extracting" { "2 / 4  正在解压新版本…" }
            "waiting" { "正在等待 Cleo 完全退出…" }
            "replacing" { "3 / 4  正在替换程序文件…" }
            "completed" { "4 / 4  Cleo $($state.version) 更新完成" }
            "failed" { "更新未完成" }
        }
        if ($state.phase -eq "failed") {
            $detail.Text = "$($state.error)`r`n可以关闭此窗口，或打开 Cleo 重新检查更新。"
            $progress.Style = "Blocks"
            $progress.Value = 0
            $openButton.Visible = Test-Path -LiteralPath (Join-Path $state.installRoot "Cleo.exe")
        } elseif ($state.phase -eq "completed") {
            $detail.Text = "新版本已安装，正在打开 Cleo。"
            $progress.Style = "Blocks"
            $progress.Value = 100
            if (-not $script:completedAt) { $script:completedAt = [DateTime]::UtcNow }
            if (([DateTime]::UtcNow - $script:completedAt).TotalSeconds -ge 3) { $form.Close(); return }
        }
        if ($script:terminal) { $closeButton.Text = "关闭" }
        if (Test-Path -LiteralPath $attentionPath) {
            $attention = [System.IO.File]::ReadAllText($attentionPath)
            if ($attention -ne $script:lastAttention) {
                $script:lastAttention = $attention
                $form.WindowState = "Normal"
                $form.Show()
                $form.Activate()
                $form.BringToFront()
            }
        }
    } catch [System.IO.IOException] {
        # Best-effort refresh; a transient status-file operation is retried on the next tick.
    }
})
$form.Add_Shown({ [System.IO.File]::WriteAllText("$StatusPath.window", [string]$PID) })
$timer.Start()
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
