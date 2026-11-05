$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$taskName = 'RealLoveTalk-VideoWorker'
$scriptPath = Join-Path $PSScriptRoot 'service-watchdog.js'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.Actions.Arguments -notlike ('*' + $scriptPath + '*')) { throw 'A different task already uses this name.' }
$powershellPath = (Get-Command powershell.exe).Source
$workerCommand = "& '" + $nodePath.Replace("'", "''") + "' '" + $scriptPath.Replace("'", "''") + "'"
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $workerCommand + '"') -WorkingDirectory $workspacePath
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$loginTrigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$minuteTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($loginTrigger,$minuteTrigger) -Principal $principal -Settings $settings -Description 'Keep the local video server available. Script schedules run inside the server. Requires an awake, signed-in Windows session.' -Force | Select-Object TaskName,State
