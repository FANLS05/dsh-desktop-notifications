# dsh-windows-notify - send one Windows toast notification.
#
# Every piece of text arrives through environment variables, so the Node caller
# never has to quote, escape, or encode anything:
#   DSH_NOTIFY_TITLE  toast title (line 1)
#   DSH_NOTIFY_BODY   toast body  (line 2, optional)
#   DSH_NOTIFY_APPID  AppUserModelID the toast is attributed to
#   DSH_NOTIFY_SOUND  'true' (default) / 'false' to mute the toast
#
# Three layers, each tried only when the previous one throws:
#   1. WinRT toast under the caller's AppUserModelID (DSH's own id, so the
#      notification shows as "DeepSeek Harness").
#   2. WinRT toast under the built-in Windows PowerShell AppUserModelID, which
#      is registered on every Windows 10/11 install.
#   3. A tray balloon in the notification area.
# Exit code 0 means at least one layer fired.

$ErrorActionPreference = 'Stop'

$title = [string]$env:DSH_NOTIFY_TITLE
$body = [string]$env:DSH_NOTIFY_BODY
$appId = [string]$env:DSH_NOTIFY_APPID
$sound = ($env:DSH_NOTIFY_SOUND -ne 'false')

$fallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DSH' }
if ($null -eq $body) { $body = '' }
if ([string]::IsNullOrWhiteSpace($appId)) { $appId = 'com.deepseek.dsh' }

function Send-WinRtToast {
    param(
        [string]$AppId,
        [string]$Title,
        [string]$Body,
        [bool]$PlaySound
    )

    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $template.GetElementsByTagName('text')
    [void]$nodes.Item(0).AppendChild($template.CreateTextNode($Title))
    if (-not [string]::IsNullOrEmpty($Body)) {
        [void]$nodes.Item(1).AppendChild($template.CreateTextNode($Body))
    }

    $audio = $template.CreateElement('audio')
    if ($PlaySound) { $audio.SetAttribute('silent', 'false') } else { $audio.SetAttribute('silent', 'true') }
    [void]$template.DocumentElement.AppendChild($audio)

    $toast = New-Object Windows.UI.Notifications.ToastNotification $template
    try { $toast.Priority = [Windows.UI.Notifications.ToastNotificationPriority]::High } catch { }

    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
}

try {
    Send-WinRtToast -AppId $appId -Title $title -Body $body -PlaySound $sound
    exit 0
} catch { }

try {
    Send-WinRtToast -AppId $fallbackAppId -Title $title -Body $body -PlaySound $sound
    exit 0
} catch { }

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = [System.Drawing.SystemIcons]::Information
    $tray.BalloonTipTitle = $title
    $tray.BalloonTipText = $body
    $tray.Visible = $true
    $tray.ShowBalloonTip(6000)
    Start-Sleep -Seconds 7
    $tray.Visible = $false
    $tray.Dispose()
    exit 0
} catch { }

exit 1
