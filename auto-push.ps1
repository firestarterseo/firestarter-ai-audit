# auto-push.ps1
#
# Watches this folder for file changes and automatically git add + commit +
# push whenever Claude syncs new files in, so you never have to run those
# commands by hand again. Debounces changes (waits for a quiet period)
# since Claude usually writes several files in quick succession per
# feature -- this batches them into one commit instead of one per file.
#
# Usage: open PowerShell in this folder and run:
#   .\auto-push.ps1
#
# Leave that window open while working with Claude. Ctrl+C to stop --
# doesn't touch anything else, just stops watching.

$repoRoot = $PSScriptRoot
Set-Location $repoRoot

$debounceSeconds = 8

# Register-ObjectEvent's -Action block runs in its own scope, NOT the
# calling script's scope -- a bare $lastChange/$pending here and a bare
# $lastChange/$pending in the while loop below would silently become two
# unrelated variables (a well-known PowerShell gotcha with this exact
# watcher+event pattern). Using $Global: consistently on both sides is what
# actually makes them the same variable.
$Global:lastChange = $null
$Global:pending = $false

Write-Host "Watching $repoRoot for changes... (Ctrl+C to stop)" -ForegroundColor Cyan

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoRoot
$watcher.IncludeSubdirectories = $true
$watcher.Filter = "*.*"
$watcher.EnableRaisingEvents = $true

$action = {
    $path = $Event.SourceEventArgs.FullPath
    # Ignore git's own internal bookkeeping -- otherwise every commit we
    # make triggers another watch event, which would fire forever.
    if ($path -notmatch '\\\.git\\') {
        $Global:lastChange = Get-Date
        $Global:pending = $true
    }
}

Register-ObjectEvent $watcher "Changed" -Action $action | Out-Null
Register-ObjectEvent $watcher "Created" -Action $action | Out-Null
Register-ObjectEvent $watcher "Deleted" -Action $action | Out-Null
Register-ObjectEvent $watcher "Renamed" -Action $action | Out-Null

try {
    while ($true) {
        Start-Sleep -Seconds 2
        if ($Global:pending -and ((Get-Date) - $Global:lastChange).TotalSeconds -ge $debounceSeconds) {
            $Global:pending = $false
            git add -A
            git diff --cached --quiet
            if ($LASTEXITCODE -ne 0) {
                $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
                Write-Host "[$stamp] Changes detected -- committing and pushing..." -ForegroundColor Yellow
                git commit -m "Auto-sync from Claude session ($stamp)" | Out-Null
                git push
                Write-Host "[$stamp] Pushed." -ForegroundColor Green
            }
        }
    }
} finally {
    Get-EventSubscriber | Unregister-Event
    $watcher.Dispose()
    Write-Host "Stopped watching." -ForegroundColor Cyan
}
