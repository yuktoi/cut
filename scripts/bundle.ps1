$root = Split-Path $PSScriptRoot -Parent
$jdk = Get-ChildItem (Join-Path $root ".jdk") -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "jdk-21*" } |
  Select-Object -First 1
if ($jdk) {
  $env:JAVA_HOME = $jdk.FullName
  $env:Path = "$($jdk.FullName)\bin;" + $env:Path
}
Set-Location $root
node scripts/sync-www.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location (Join-Path $root "android")
.\gradlew.bat bundleRelease
exit $LASTEXITCODE
