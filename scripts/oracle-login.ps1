param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[a-z]{2}-[a-z0-9-]+-[0-9]+$')]
    [string]$Region,
    [string]$TenancyName
)
$ErrorActionPreference = 'Stop'
$backendDir = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $backendDir '.local/oci-venv/Scripts/oci.exe'
$stateDir = Join-Path $backendDir '.local/oracle'
if (-not (Test-Path -LiteralPath $cli)) {
    throw 'Oracle CLI is missing. Install the pinned CLI in backend/.local/oci-venv first.'
}
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$cliArguments = @('session', 'authenticate', '--region', $Region,
    '--profile-name', 'SYNAPSE_ORACLE', '--config-location', (Join-Path $stateDir 'config'),
    '--token-location', (Join-Path $stateDir 'sessions'), '--session-expiration-in-minutes', '60')
if ($TenancyName) { $cliArguments += @('--tenancy-name', $TenancyName) }
Write-Host 'Complete Oracle sign-in in the browser. Do not paste passwords, OTPs or tokens into chat.'
& $cli @cliArguments
if ($LASTEXITCODE -ne 0) { throw 'Oracle sign-in did not complete.' }
& $cli session validate --config-file (Join-Path $stateDir 'config') --profile SYNAPSE_ORACLE --auth security_token
if ($LASTEXITCODE -ne 0) { throw 'Oracle session validation failed.' }
