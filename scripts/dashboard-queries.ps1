# Fixed, read-only dashboard queries. Stdin contains a correlation ID and a verb,
# never executable text. -Query runs the same collector once without reading stdin.
param([ValidateSet('ports', 'owners', 'processes', 'debug-processes')][string]$Query)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'

function Get-DashboardQuery([string]$Verb) {
    switch -Exact ($Verb) {
        'ports' {
            Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Select-Object LocalPort,OwningProcess,LocalAddress | ConvertTo-Json -Compress -Depth 3
        }
        'owners' {
            Get-CimInstance Win32_Process |
                Select-Object ProcessId,Name,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} |
                ConvertTo-Json -Compress -Depth 3
        }
        'debug-processes' {
            Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%remote-debugging-port%'" |
                Select-Object ProcessId,Name,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} |
                ConvertTo-Json -Compress -Depth 3
        }
        'processes' {
            $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
                [pscustomobject]@{
                    pid = [int]$_.ProcessId
                    ppid = [int]$_.ParentProcessId
                    name = $_.Name
                    commandLine = $_.CommandLine
                    memoryBytes = [int64]$_.WorkingSetSize
                }
            }
            $conns = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object {
                [pscustomobject]@{
                    localPort = [int]$_.LocalPort
                    remoteAddress = [string]$_.RemoteAddress
                    remotePort = [int]$_.RemotePort
                    owningPid = [int]$_.OwningProcess
                }
            }
            [pscustomobject]@{ processes = @($procs); connections = @($conns) } | ConvertTo-Json -Depth 4 -Compress
        }
        default { throw 'Unknown dashboard query' }
    }
}

if ($Query) {
    try { Get-DashboardQuery $Query; exit 0 }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
while ($null -ne ($line = $reader.ReadLine())) {
    if ($line -notmatch '^(__PAAT_PS_[a-f0-9]{32}__) ([a-z-]+)$') { continue }
    $marker = $Matches[1]
    $verb = $Matches[2]
    $code = 0
    $text = ''
    try { $text = Get-DashboardQuery $verb | Out-String -Width 8192 }
    catch { $code = 1; $text = $_.Exception.Message }
    [Console]::Out.Write([string]$text + "`n" + $marker + ' ' + $code + "`n")
    [Console]::Out.Flush()
}
