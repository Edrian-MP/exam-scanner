$ErrorActionPreference = 'Stop'
$startupDir = 'C:\xampp\htdocs\exam-scanner\startup'
$userStartup = [Environment]::GetFolderPath('Startup')
New-Item -ItemType Directory -Path (Join-Path $startupDir 'logs') -Force | Out-Null
$wsh = New-Object -ComObject WScript.Shell
$shortcuts = @(
  @{ Name = 'Exam Scanner - Start XAMPP.lnk'; Target = Join-Path $startupDir 'start-xampp.bat'; Working = $startupDir; WindowStyle = 7; Description = 'Start XAMPP Apache and MySQL for Exam Scanner' },
  @{ Name = 'Exam Scanner - Scanner Service.lnk'; Target = Join-Path $startupDir 'start-scanner-service.bat'; Working = 'C:\xampp\htdocs\exam-scanner'; WindowStyle = 1; Description = 'Start visible scanner-service terminal for Exam Scanner' },
  @{ Name = 'Exam Scanner - Open Webapp.lnk'; Target = Join-Path $startupDir 'open-webapp.bat'; Working = $startupDir; WindowStyle = 7; Description = 'Open Exam Scanner web app after login' }
)
foreach ($item in $shortcuts) {
  $linkPath = Join-Path $userStartup $item.Name
  $shortcut = $wsh.CreateShortcut($linkPath)
  $shortcut.TargetPath = $item.Target
  $shortcut.WorkingDirectory = $item.Working
  $shortcut.WindowStyle = $item.WindowStyle
  $shortcut.Description = $item.Description
  $shortcut.Save()
}
Write-Output 'SHORTCUTS_CREATED'
