# Sets up a Windows-native build mirror of the WSL repo with portable Node 24.
$ErrorActionPreference = "Stop"
$root = "$env:USERPROFILE\dev"
$tools = "$root\tools"
$build = "$root\openwhispr"
New-Item -ItemType Directory -Force $tools | Out-Null
$nodeDir = Get-ChildItem $tools -Directory -Filter "node-v24*" -EA SilentlyContinue | Select-Object -First 1
if (-not $nodeDir) {
  $idx = Invoke-RestMethod https://nodejs.org/dist/index.json
  $v = ($idx | Where-Object { $_.version -like "v24.*" } | Select-Object -First 1).version
  $zip = "$tools\node-$v-win-x64.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $tools -Force
  Remove-Item $zip
  $nodeDir = Get-Item "$tools\node-$v-win-x64"
}
$env:PATH = "$($nodeDir.FullName);$env:PATH"
node -v
$src = "\\wsl.localhost\Ubuntu\home\hwg\projects\openwhispr"
if (-not (Test-Path "$build\.git")) {
  git -c safe.directory=* clone $src $build
}
Set-Location $build
git -c safe.directory=* fetch origin
git checkout -B hwg/provida-flow origin/hwg/provida-flow
npm ci
