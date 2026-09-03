[CmdletBinding()]
param(
  [ValidateSet("1.0.2")]
  [string]$Version = "1.0.2",
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedSha256 = "9f8b288d4e2af47084cf8c4cf63d3a988b59ee7acb2b074b111a5537946a1e48"
$packageName = "effectgate-preview-$Version.tgz"
$packageUrl = "https://github.com/Miniks040506/EffectGate/releases/download/v$Version/$packageName"

$nodeMajor = & node -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 24) {
  throw "EffectGate requires Node.js 24 or newer."
}
& npm --version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "npm is required to install EffectGate."
}

if ($Check) {
  [pscustomobject]@{
    version = $Version
    package_url = $packageUrl
    sha256 = $expectedSha256
    node_major = [int]$nodeMajor
  } | ConvertTo-Json -Compress
  exit 0
}

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = [IO.Path]::GetFullPath((Join-Path $temporaryRoot (
  "effectgate-install-" + [Guid]::NewGuid().ToString("N")
)))
if (-not $work.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe temporary installer path."
}
New-Item -ItemType Directory -Path $work | Out-Null

try {
  $package = Join-Path $work $packageName
  Invoke-WebRequest -Uri $packageUrl -OutFile $package
  $actualSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "EffectGate package checksum mismatch."
  }
  & npm install --global --ignore-scripts --no-audit --no-fund $package
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed to install EffectGate."
  }
  $installedVersion = (& effectgate --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $installedVersion -ne $Version) {
    throw "Installed EffectGate version verification failed."
  }
  Write-Output "EffectGate $installedVersion installed and verified."
} finally {
  if ($work.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
}
