# Concat no Windows com Codex

Este fork mantém o Concat original e acrescenta uma ponte MCP local em `tools/codex`.
O GitHub guarda o código. A edição, os projetos e a renderização são executados no PC.
Concat é um editor independente e uma alternativa ao CapCut; esta integração não controla o aplicativo CapCut nem converte seus rascunhos proprietários.

## Usar neste PC

1. Abra **Concat** pelo menu Iniciar e mantenha a janela aberta.
2. Deixe o projeto a ser automatizado fechado na interface (volte à tela inicial).
3. Coloque os vídeos, imagens e áudios na pasta `materials` deste repositório, ou informe seus caminhos locais ao Codex.
4. Peça ao Codex uma edição. Exemplo: “Crie um Reels vertical de 20 segundos com os vídeos da pasta materials, cortes rápidos, título e música. Salve o projeto em projects e o MP4 em exports.”
5. Ao terminar, abra o projeto salvo no Concat para revisar a timeline. Para outra rodada de automação, salve e feche esse projeto na interface primeiro.

O MCP se chama **concat_local**. As ferramentas podem exigir recarregar os servidores MCP ou reabrir o Codex depois do primeiro registro. Enquanto isso, `cli.mjs` permite usar a mesma API nesta conversa.

### O que “em tempo real” permite

O Codex envia comandos à instância local aberta e recebe respostas, prévias e eventos de exportação.
Na versão 0.2.7, o editor e a API mantêm sessões distintas: a API recusa editar um projeto que está aberto na interface.
Para ver as mudanças da automação na timeline, abra/reabra o projeto depois de salvá-lo pela API.
Não existe edição colaborativa simultânea da mesma timeline nesta configuração.

### Ferramentas

| Ferramenta | Função |
|---|---|
| `concat_start` | Abrir o editor se estiver fechado |
| `concat_status` | Conferir versão e conexão |
| `concat_read` | Ler projetos, documentos, efeitos e informações de mídia |
| `concat_edit` | Criar projeto, importar mídias, aplicar cortes/títulos/efeitos e salvar |
| `concat_preview` | Ver um frame PNG no Codex |
| `concat_export` | Exportar MP4 e acompanhar o resultado inicial |
| `concat_events` | Consultar progresso/conclusão da exportação |

Uma exportação só terminou quando retornar `export.done`. `export.pending` exige consultar eventos.
A ponte recusa sobrescrever uma exportação existente. Após erro de conexão ou timeout, confira o documento antes de repetir uma edição: uma resposta perdida não prova que a operação falhou.

## Instalação reproduzível

Requisitos: Windows x64, Node.js 22 ou superior, PowerShell 7 e Codex instalado.

Na raiz deste repositório, com o Concat fechado:

```powershell
pwsh -File .\tools\codex\setup-windows.ps1
```

O script instala a versão oficial **0.2.7**, se ainda não existir, verifica SHA-256, configura português, cria um token e registra o MCP no Codex. Ele preserva cópias das configurações anteriores em `.local`.
Um Concat já instalado é preservado; confirme a compatibilidade com `concat_status`.
O SDK MCP é fixado no `package-lock.json`; dependências são instaladas sem executar scripts de pacotes.

O instalador oficial é de [jub0t/Concat, release v0.2.7](https://github.com/jub0t/Concat/releases/tag/v0.2.7).
SHA-256 do instalador x64: `305e833449c24c234c935244debd339a4ba25866fe5787c744f374c7ee5b9687`.

O binário fica em `%LOCALAPPDATA%\Programs\Concat\concat.exe`.
Preferências e token ficam em `%APPDATA%\app.concat.editor\settings.json`.
Logs e modelos ficam em `%LOCALAPPDATA%\app.concat.editor`.
Se usar uma instalação portátil, defina `CONCAT_SETTINGS_PATH` apontando para o `settings.json` dela.

Se o Windows bloquear gravação em Documentos, use uma pasta de trabalho permitida. Não é necessário desativar o Defender.

## Testar

```powershell
cd tools\codex
npm test
npm run smoke
```

O teste real abre o editor, faz o handshake MCP, cria um projeto vertical novo de 4 segundos, adiciona títulos, salva, obtém uma prévia, exporta MP4 e consulta a mídia exportada.
O relatório fica em `.local/verification/latest.json`, com arquivos identificados por data e hora. Os testes não precisam dos seus vídeos.

Fallback pela linha de comando, a partir da raiz:

```powershell
node tools/codex/cli.mjs version
node tools/codex/cli.mjs project.list
node tools/codex/cli.mjs project.create '@pedido.json'
```

Use arquivos JSON para parâmetros complexos. Exemplo de `pedido.json`:

```json
{
  "location": "C:/MinhaPasta/Concat/projects",
  "name": "Reels 01",
  "video": { "width": 1080, "height": 1920, "rateNum": 30, "rateDen": 1 }
}
```

`edit.apply` recebe `{ "path": "caminho/do/projeto", "command": { "op": "..." } }`.
O contrato da API está em `src/crates/concat-api/src/message.rs`, e os comandos em `src/crates/concat-project/src/commands/mod.rs`. Consulte o código da tag **v0.2.7** ao automatizar o binário instalado; `main` pode conter funcionalidades posteriores.

Os modelos opcionais de legendas, voz e remoção de fundo exigem download em Configurações do Concat. A API desta versão não expõe todos esses recursos de IA. A instalação básica não baixa modelos grandes nem configura serviços pagos.

## Arquivos privados e manutenção

`materials/`, `projects/`, `exports/`, `.local/` e `node_modules/` são ignorados pelo Git. Vídeos e tokens permanecem locais. Não use `git add -f` nessas pastas.
O token é lido diretamente das preferências do Concat, não fica no código nem no registro MCP.
A API fica restrita a `127.0.0.1:7420`. Esta ponte não abre portas na rede, não publica vídeos e não usa uma chave da API OpenAI.

O código original continua AGPL-3.0-or-later, com seus avisos e autoria preservados.
O remote `upstream` aponta para o projeto original; `origin` aponta para este fork.
Atualize conscientemente o código, o aplicativo e o teste real; um `git pull` não atualiza o aplicativo instalado.

Para remover a integração, execute `codex mcp remove concat_local` e desative a API nas configurações do Concat. O editor pode ser removido em Aplicativos Instalados do Windows. As pastas de materiais, projetos e exportações permanecem para você preservar.
