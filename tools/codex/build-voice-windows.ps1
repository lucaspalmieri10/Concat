param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
$Native = Join-Path $RuntimeDirectory 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release\lib\sherpa-onnx-c-api.dll'
if (!(Test-Path -LiteralPath $Native)) { throw 'Instale primeiro sherpa-onnx 1.13.8 x64 shared MD Release, conforme ai-assets.lock.json.' }
$Output = Join-Path $RuntimeDirectory 'voice'
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$Compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $Compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$Output\concat-voice.exe" (Join-Path $PSScriptRoot 'VoiceWindows.cs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar a ponte de voz UTF-8.' }
Get-FileHash -LiteralPath (Join-Path $Output 'concat-voice.exe') -Algorithm SHA256
