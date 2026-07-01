$ErrorActionPreference = "Stop"

$Repo = if ($env:ASX_REPO) { $env:ASX_REPO } else { "enif-lee/asx" }
$Version = if ($env:ASX_VERSION) { $env:ASX_VERSION } else { "latest" }
$MinNodeMajor = 20
$GithubToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
$GithubHeaders = @{}
if ($GithubToken) {
  $GithubHeaders["Authorization"] = "Bearer $GithubToken"
  $GithubHeaders["Accept"] = "application/vnd.github+json"
}

function Write-Step($Message) {
  Write-Host $Message
}

function Fail($Message) {
  throw "asx install error: $Message"
}

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Node {
  if (-not (Has-Command "node")) { return $false }
  $major = & node -p "Number(process.versions.node.split('.')[0])"
  return ([int]$major -ge $MinNodeMajor)
}

function Test-PackageManager {
  return (Has-Command "npm") -or (Has-Command "pnpm")
}

function Update-CurrentPath {
  $paths = @(
    (Join-Path $env:ProgramFiles "nodejs"),
    (Join-Path $env:APPDATA "npm")
  )

  foreach ($path in $paths) {
    if ((Test-Path $path) -and (($env:Path -split ';') -notcontains $path)) {
      $env:Path = "$path;$env:Path"
    }
  }
}

function Install-NodeLts {
  Write-Step "Installing Node.js LTS..."

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $fileName = "win-$arch-msi"
  $release = $index | Where-Object { $_.lts -and ($_.files -contains $fileName) } | Select-Object -First 1
  if (-not $release) { Fail "failed to find a Node.js LTS Windows MSI for $arch." }

  $msiUrl = "https://nodejs.org/dist/$($release.version)/node-$($release.version)-win-$arch.msi"
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) "node-$($release.version)-win-$arch.msi"

  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath
  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msiPath, "/qn", "/norestart") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Fail "Node.js installer failed with exit code $($process.ExitCode). Try running PowerShell as Administrator."
  }

  Update-CurrentPath
}

function Get-PackageManager {
  if (Has-Command "npm") { return "npm" }
  if (Has-Command "pnpm") { return "pnpm" }
  Fail "npm or pnpm is required."
}

function Get-ReleasePackage {
  if ($env:ASX_INSTALL_TARGET) {
    if (Test-Path $env:ASX_INSTALL_TARGET) {
      return (Resolve-Path $env:ASX_INSTALL_TARGET).Path
    }
    return $env:ASX_INSTALL_TARGET
  }

  if ($Version -eq "latest") {
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
  } else {
    $apiUrl = "https://api.github.com/repos/$Repo/releases/tags/$Version"
  }

  $release = Invoke-RestMethod -Uri $apiUrl -Headers $GithubHeaders
  $asset = $release.assets | Where-Object { $_.name -match '^asx-.*\.tgz$' } | Select-Object -First 1
  if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -match '\.tgz$' } | Select-Object -First 1
  }
  if (-not $asset) {
    Fail "no asx .tgz release asset found for $($release.tag_name)."
  }

  $packagePath = Join-Path ([IO.Path]::GetTempPath()) $asset.name
  if ($GithubToken) {
    $downloadHeaders = @{
      Authorization = "Bearer $GithubToken"
      Accept = "application/octet-stream"
    }
    Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $packagePath
  } else {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $packagePath
  }
  return $packagePath
}

if ((-not (Test-Node)) -or (-not (Test-PackageManager))) {
  Install-NodeLts
}

if (-not (Test-Node)) { Fail "Node.js >= $MinNodeMajor is required." }
$pm = Get-PackageManager
$packagePath = Get-ReleasePackage

Write-Step "Installing ASX with $pm..."
if ($pm -eq "npm") {
  & npm install -g $packagePath
} else {
  & pnpm add -g $packagePath
}
if ($LASTEXITCODE -ne 0) { Fail "$pm install failed." }

if (-not (Has-Command "asx")) { Fail "ASX installed, but 'asx' is not on PATH." }
$versionText = & asx --version
Write-Step "ASX installed: $versionText"
