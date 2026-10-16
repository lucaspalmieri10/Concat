// SPDX-License-Identifier: AGPL-3.0-or-later
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

export function settingsPath() {
  if (process.env.CONCAT_SETTINGS_PATH) return process.env.CONCAT_SETTINGS_PATH;
  if (process.platform === 'win32') return join(process.env.APPDATA, 'app.concat.editor', 'settings.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'app.concat.editor', 'settings.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'app.concat.editor', 'settings.json');
}

export async function connectionOptions() {
  const settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
  if (!settings.server?.enabled) throw new Error('Ative a API em Configurações > Remoto/Automação no Concat.');
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(settings.server.listen);
  if (!match) throw new Error('Esta integração aceita somente uma API local (loopback).');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Porta local inválida.');
  if (!settings.server.token) throw new Error('Configure um token local na API do Concat.');
  return { host: match[1].replace(/[\[\]]/g, ''), port, token: settings.server.token };
}

export class ConcatClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.pending = new Map();
    this.events = [];
    this.sequence = 0;
    this.requestId = 0;
    this.buffer = '';
    this.ready = false;
  }

  async connect() {
    if (this.ready) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async _connect() {
    this.options ??= await connectionOptions();
    this.buffer = '';
    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', chunk => this.consume(chunk));
    socket.on('error', error => this.rejectPending(error));
    socket.on('close', () => {
      this.ready = false;
      this.rejectPending(new Error('Conexão com o Concat encerrada. Nenhuma edição foi repetida automaticamente.'));
      this.emit('disconnected');
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('O Concat não respondeu. Abra o editor e ative sua API.')); }, 5000);
        const connected = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
        const failed = error => { clearTimeout(timer); socket.off('connect', connected); reject(error); };
        socket.once('connect', connected);
        socket.once('error', failed);
      });
      await this.request('auth', { token: this.options.token }, 5000);
      this.ready = true;
      return this;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 64 * 1024 * 1024) {
      this.socket.destroy(new Error('Resposta do Concat excedeu 64 MiB. Solicite uma prévia menor.'));
      return;
    }
    for (let newline; (newline = this.buffer.indexOf('\n')) !== -1;) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.socket.destroy(new Error('Resposta JSON inválida do Concat.')); return; }
      if (Object.hasOwn(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message || 'Erro da API do Concat');
          error.code = message.error.data?.code ?? message.error.code;
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method) {
        const event = { sequence: ++this.sequence, receivedAt: new Date().toISOString(), ...message };
        this.events.push(event);
        if (this.events.length > 256) this.events.shift();
        this.emit('notification', event);
      }
    }
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Abra o Concat antes de enviar comandos.'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo limite em ${method}. A operação pode continuar no editor; confira o estado antes de repetir.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  waitForExport(job, timeoutMs = 60000) {
    const terminal = event => event.params?.job === job && ['export.done', 'export.failed'].includes(event.method);
    const existing = this.events.find(terminal);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('notification', onEvent); this.off('disconnected', onClose); };
      const onEvent = event => { if (terminal(event)) { cleanup(); resolve(event); } };
      const onClose = () => { cleanup(); reject(new Error('Conexão encerrada durante a exportação; confira o arquivo antes de repetir.')); };
      const timer = setTimeout(() => { cleanup(); resolve({ method: 'export.pending', params: { job } }); }, timeoutMs);
      this.on('notification', onEvent);
      this.on('disconnected', onClose);
    });
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  close() { this.socket?.destroy(); }
}
