# Concat no Windows com Codex

Este fork mantém o Concat original e acrescenta uma ponte MCP local em `tools/codex`.
O GitHub guarda o código. A edição, os projetos e a renderização são executados no PC.
Concat é um editor independente e uma alternativa ao CapCut; esta integração não controla o aplicativo CapCut nem converte seus rascunhos proprietários.

## Usar neste PC

1. Abra **ABRIR CONCAT** na pasta `CAPCUT` e mantenha a janela aberta.
2. Deixe o projeto a ser automatizado fechado na interface (volte à tela inicial).
3. Coloque os vídeos, imagens e áudios na pasta `CAPCUT/Materiais`, ou informe seus caminhos locais ao Codex.
4. Peça ao Codex uma edição. Exemplo: “Crie um Reels vertical de 20 segundos com os vídeos de Materiais, cortes rápidos, narração em português e legendas. Salve o projeto em Projetos e o MP4 em Exportacoes.”
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
| `concat_ai_status` | Conferir os motores e modelos de voz e legendas |
| `concat_narrate` | Gerar narração local PT-BR com Dora, Alex, Santa ou Jeff |
| `concat_transcribe` | Gerar legendas SRT, texto e tempos a partir de vídeo/áudio |
| `concat_ai_job` | Acompanhar a tarefa de narração ou transcrição |

Uma exportação só terminou quando retornar `export.done`. `export.pending` exige consultar eventos.
A ponte recusa sobrescrever uma exportação existente. Após erro de conexão ou timeout, confira o documento antes de repetir uma edição: uma resposta perdida não prova que a operação falhou.

### Instalação portátil e modelos

A instalação preparada usa `CAPCUT/Aplicativo/concat.exe`. O diretório `portable` ao lado do executável concentra preferências, modelos e caches, conforme o suporte nativo do Concat.
O código fica em `CAPCUT/Concat`; motores auxiliares ficam em `CAPCUT/Ferramentas`; materiais, projetos e exportações ficam nas pastas próprias de `CAPCUT`.

Modelos instalados: Whisper **small** (padrão) e **base**, ambos multilíngues; Kokoro INT8 e Pocket TTS; RVM para pessoas; ISNet para objetos; SlimSAM encoder/decoder para seleção assistida; RealESR para melhoria de resolução; Piper Jeff PT-BR como alternativa de voz.
`ai-assets.lock.json` registra as fontes, tamanhos e hashes verificados. Modelos e programas auxiliares permanecem locais, fora do Git.

O painel de voz do Concat 0.2.7 oferece as vozes inglesas/chinesas selecionadas pelo programa. A ponte adicional usa o Kokoro em português brasileiro por `concat_narrate`: Dora é a voz padrão, Alex e Santa são alternativas masculinas e Jeff usa Piper. O WAV resultante pode ser importado normalmente no editor.
`VoiceWindows.cs` envia texto em UTF-8 à biblioteca sherpa-onnx 1.13.8: isso corrige os acentos que o executável oficial de linha de comando perde ao receber argumentos ANSI no Windows. A ponte compilada é específica para esse ABI x64 e não deve receber outra versão de DLL sem revisão.

`concat_transcribe` usa FFmpeg para preparar o áudio e Whisper para escrever SRT/JSON/TXT. O idioma padrão é português; a fala é transcrita, sem tradução. A revisão de nomes, números e sincronização continua fazendo parte da edição.
As tarefas são assíncronas: aguarde `concat_ai_job` retornar **completed** antes de importar a saída. IDs valem somente enquanto esse servidor MCP estiver ativo; se ele reiniciar, confira os arquivos existentes antes de repetir. A transcrição conserva o WAV mono 16 kHz para conferência. A pasta de saída deve existir.

Para inserir as legendas na timeline, leia os segmentos do JSON (`offsets` em milissegundos), crie `addTextClip` com `start`, `duration`, `above: true`, estilo legível e texto revisado, então execute `project.save`. Para recorte, use `setClipCutout` com `cutout: {mode: "auto", subject: "person"}` ou `subject: "object"`; a exportação do Concat analisa as máscaras com os modelos instalados.

O MCP portátil recebe `CONCAT_HOME`, `CONCAT_EXE` e `CONCAT_SETTINGS_PATH`. `CONCAT_AI_RUNTIME` e `CONCAT_MODELS_DIR` permitem caminhos alternativos em testes. O token continua apenas no arquivo local de preferências. O servidor portátil usa `127.0.0.1:7421`, separado da instalação inicial na porta 7420.
O Acesso Controlado a Pastas requer autorização específica para o Concat, a ponte de voz, Whisper e FFmpeg gravarem em Documentos. A proteção do Windows pode permanecer ativa.

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

O script básico acima instala somente o editor. A instalação portátil com IA descrita nesta página inclui os modelos e os motores adicionais. Os recursos nativos de transcrição e voz não têm métodos na API 0.2.7; por isso as ferramentas de voz/legendas usam motores locais separados e entregam arquivos compatíveis com o editor.

## Arquivos privados e manutenção

`materials/`, `projects/`, `exports/`, `.local/` e `node_modules/` são ignorados pelo Git. Vídeos e tokens permanecem locais. Não use `git add -f` nessas pastas.
O token é lido diretamente das preferências do Concat, não fica no código nem no registro MCP.
A API fica restrita ao endereço de loopback configurado (`127.0.0.1:7421` nesta instalação portátil). Esta ponte não publica vídeos e não usa uma chave da API OpenAI.

O código original continua AGPL-3.0-or-later, com seus avisos e autoria preservados.
O remote `upstream` aponta para o projeto original; `origin` aponta para este fork.
Atualize conscientemente o código, o aplicativo e o teste real; um `git pull` não atualiza o aplicativo instalado.

Para remover a integração, execute `codex mcp remove concat_local` e desative a API nas configurações do Concat. O editor pode ser removido em Aplicativos Instalados do Windows. As pastas de materiais, projetos e exportações permanecem para você preservar.
