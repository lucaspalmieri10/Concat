# Installs the official release and configures the local Codex bridge.
# SPDX-License-Identifier: AGPL-3.0-or-later
[CmdletBinding()]
param([switch]$SkipMcpRegistration)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localDir = Join-Path $repoRoot '.local'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Concat\concat.exe'
$settingsPath = Join-Path $env:APPDATA 'app.concat.editor\settings.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Get-Command node, npm.cmd -ErrorAction Stop | Out-Null
if (-not $SkipMcpRegistration) { Get-Command codex -ErrorAction Stop | Out-Null }
if (Get-Process concat -ErrorAction SilentlyContinue) { throw 'Salve seus projetos e feche o Concat antes de configurar.' }
foreach ($folder in @('.local', '.local\downloads', 'materials', 'projects', 'exports')) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot $folder) -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $exe)) {
    $installer = Join-Path $localDir 'downloads\Concat-0.2.7-windows-x86_64-setup.exe'
    if (-not (Test-Path -LiteralPath $installer)) {
        Invoke-WebRequest 'https://github.com/jub0t/Concat/releases/download/v0.2.7/Concat-0.2.7-windows-x86_64-setup.exe' -OutFile $installer
    }
    $expected = '305e833449c24c234c935244debd339a4ba25866fe5787c744f374c7ee5b9687'
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA-256 do instalador divergente.' }
    $installerArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER', '/LANG=brazilianportuguese', ('/DIR="' + (Split-Path $exe) + '"'), ('/LOG="' + (Join-Path $localDir "install-$stamp.log") + '"'))
    $setup = Start-Process -FilePath $installer -ArgumentList $installerArgs -PassThru -Wait -WindowStyle Hidden
    if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'A instalação não foi concluída.' }
}
$settings = @{}
if (Test-Path -LiteralPath $settingsPath) {
    Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $localDir "concat-settings-before-$stamp.json")
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
}
$settings.locale = 'pt-BR'
$token = $settings.server.token
if (-not $token) { $token = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
$settings.server = @{ enabled = $true; listen = '127.0.0.1:7420'; token = $token }
New-Item -ItemType Directory -Path (Split-Path $settingsPath) -Force | Out-Null
$settings | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $settingsPath -Encoding utf8
$verifiedSettings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
if ($verifiedSettings.server.token -ne $token -or -not $verifiedSettings.server.enabled) { throw 'Falha ao verificar as preferências.' }
Push-Location $PSScriptRoot
try {
    npm.cmd ci --ignore-scripts --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências MCP.' }
} finally { Pop-Location }
if (-not $SkipMcpRegistration) {
    $codexConfig = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }) 'config.toml'
    if (Test-Path -LiteralPath $codexConfig) {
        if (Select-String -LiteralPath $codexConfig -Pattern '^\[mcp_servers\.concat_local\]' -Quiet) { throw 'concat_local já está registrado. Confira codex mcp get concat_local antes de substituir.' }
        Copy-Item -LiteralPath $codexConfig -Destination (Join-Path $localDir "codex-config-before-$stamp.toml")
    }
    codex mcp add concat_local -- (Get-Command node).Source (Join-Path $PSScriptRoot 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao registrar MCP; os arquivos locais foram preservados.' }
    $configText = [System.IO.File]::ReadAllText($codexConfig)
    $section = '[mcp_servers.concat_local]'
    $configText = $configText.Replace($section, ($section + "`nstartup_timeout_sec = 30`ntool_timeout_sec = 180"))
    [System.IO.File]::WriteAllText($codexConfig, $configText, [System.Text.UTF8Encoding]::new($false))
}
Write-Output 'Configuração concluída. Abra Concat pelo menu Iniciar e execute npm run smoke em tools/codex.'
Write-Output 'Se as ferramentas ainda não aparecerem no Codex, recarregue os servidores MCP ou reabra o aplicativo.'
