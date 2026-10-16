// SPDX-License-Identifier: AGPL-3.0-or-later
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConcatClient } from './client.mjs';

const reads = ['project.list', 'project.get', 'project.document', 'media.probe', 'catalogue.list', 'template.list'];
const writes = ['project.create', 'project.open', 'project.close', 'project.save', 'project.setVideo', 'edit.apply', 'edit.undo', 'edit.redo', 'media.import', 'template.instantiate', 'template.save', 'export.cancel'];
const object = { type: 'object', additionalProperties: true };
const empty = { type: 'object', properties: {}, additionalProperties: false };
const rpcSchema = methods => ({ type: 'object', properties: { method: { type: 'string', enum: methods }, params: object }, required: ['method'], additionalProperties: false });
const tools = [
  { name: 'concat_status', description: 'Verifica a conexão autenticada com o Concat local e informa versão e capacidades.', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'concat_start', description: 'Abre a janela do Concat no Windows. Use somente quando o editor estiver fechado.', inputSchema: empty },
  { name: 'concat_read', description: 'Consulta projetos, documento, mídia e efeitos. project.get/document exigem path de um projeto aberto pela API. Nunca retorna o token.', inputSchema: rpcSchema(reads), annotations: { readOnlyHint: true } },
  { name: 'concat_edit', description: 'Cria e edita projetos locais via API Concat. Use os parâmetros oficiais em camelCase. edit.apply recebe {path,command:{op,...}}. Salve com project.save. A API não sincroniza uma timeline já aberta na interface; reabra o projeto salvo para visualizar. Consulte tools/codex/README.pt-BR.md antes da primeira edição.', inputSchema: rpcSchema(writes), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'concat_preview', description: 'Renderiza uma prévia PNG de um projeto aberto pela API. Retorna a imagem ao Codex. Não altera o documento.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, time: { type: 'number', minimum: 0 }, width: { type: 'integer', minimum: 16, maximum: 1920 }, height: { type: 'integer', minimum: 16, maximum: 1920 } }, required: ['path', 'time'], additionalProperties: false } },
  { name: 'concat_export', description: 'Exporta um projeto para um novo arquivo MP4 local. Recusa sobrescrever um arquivo existente. Aguarda até 45 segundos; se ainda estiver exportando, consulte concat_events sem iniciar outra exportação.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, output: { type: 'string' }, width: { type: 'integer', minimum: 16 }, height: { type: 'integer', minimum: 16 }, crf: { type: 'integer', minimum: 0, maximum: 51 }, preset: { type: 'string', enum: ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'] } }, required: ['path','output'], additionalProperties: false } },
  { name: 'concat_events', description: 'Últimos eventos de exportação recebidos nesta conexão. export.done confirma conclusão; export.failed indica falha. Eventos anteriores à conexão não podem ser recuperados.', inputSchema: { type: 'object', properties: { after: { type: 'integer', minimum: 0 }, job: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } }
];
let client;
let connecting;
async function connected() {
  if (client?.ready) return client;
  if (connecting) return connecting;
  client?.close();
  client = new ConcatClient();
  connecting = client.connect();
  try { return await connecting; } finally { connecting = null; }
}
const asText = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const server = new Server({ name: 'concat-local', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  try {
    if (request.params.name === 'concat_start') {
      try { const active = await connected(); return asText({ alreadyRunning: true, ...await active.request('version') }); }
      catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
      const exe = process.env.CONCAT_EXE || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Programs', 'Concat', 'concat.exe') : null);
      if (!exe) throw new Error('Configure CONCAT_EXE para este sistema.');
      await access(exe);
      if (process.platform === 'win32') {
        // Ask the Windows shell to launch the editor independently. MCP clients
        // may terminate their server's child process tree when reconnecting;
        // the user's editor and unsaved work must not be part of that tree.
        const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; $launcher = New-Object -ComObject Shell.Application; $launcher.ShellExecute($env:CONCAT_LAUNCH_EXE, "", "", "open", 1)'], { env: { ...process.env, CONCAT_LAUNCH_EXE: exe }, windowsHide: true, timeout: 10000 });
      } else {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      }
      return asText({ launched: true, message: 'Aguarde a abertura e use concat_status.' });
    }
    if (request.params.name === 'concat_events') return asText({ connected: !!client?.ready, events: (client?.events ?? []).filter(event => event.sequence > (args.after ?? 0) && (!args.job || event.params?.job === args.job)) });
    const api = await connected();
    switch (request.params.name) {
      case 'concat_status': return asText(await api.request('version'));
      case 'concat_read':
      case 'concat_edit': {
        const allowed = request.params.name === 'concat_read' ? reads : writes;
        if (!allowed.includes(args.method)) throw new Error('Método não permitido nesta ferramenta.');
        return asText(await api.request(args.method, args.params ?? {}));
      }
      case 'concat_preview': {
        const result = await api.request('preview.frame', { width: 540, height: 960, ...args }, 45000);
        if (!result.png) return asText(result);
        return { content: [{ type: 'image', mimeType: 'image/png', data: result.png }] };
      }
      case 'concat_export': {
        let exists = false;
        try { await access(args.output); exists = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (exists) throw new Error('O arquivo de saída já existe. Escolha outro nome.');
        const started = await api.request('export.run', args);
        const event = await api.waitForExport(started.job, 45000);
        const response = asText({ started, event });
        if (event.method === 'export.failed') response.isError = true;
        return response;
      }
      default: throw new Error('Ferramenta desconhecida.');
    }
  } catch (error) { return { ...asText({ error: error.message, code: error.code }), isError: true }; }
});
const transport = new StdioServerTransport();
await server.connect(transport);
server.onclose = () => { client?.close(); };
process.stdin.on('end', () => { client?.close(); });
