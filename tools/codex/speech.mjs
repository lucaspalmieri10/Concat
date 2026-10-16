// SPDX-License-Identifier: AGPL-3.0-or-later
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const home = process.env.CONCAT_HOME || resolve(repo, '..');
const runtime = process.env.CONCAT_AI_RUNTIME || join(home, 'Ferramentas');
const models = process.env.CONCAT_MODELS_DIR || join(home, 'Aplicativo', 'portable');
const sherpa = join(runtime, 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release', 'bin', 'sherpa-onnx-offline-tts.exe');
const voiceBridge = join(runtime, 'voice', 'concat-voice.exe');
const whisper = join(runtime, 'whisper', 'Release', 'whisper-cli.exe');
const ffmpeg = join(runtime, 'ffmpeg', 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1', 'bin', 'ffmpeg.exe');
const voice = join(runtime, 'vits-piper-pt_BR-jeff-medium');
const kokoro = join(models, 'tts-models', 'kokoro-int8-multi-lang-v1_0');
const jobs = new Map();
const reservations = new Set();
const done = new Set(['completed', 'failed']);

export const speechTools = [
  { name: 'concat_ai_status', description: 'Confere se os motores locais e modelos de voz PT-BR e legendas estão instalados.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'concat_narrate', description: 'Gera WAV com voz local em português brasileiro. Voz padrão Dora; alternativas Alex, Santa e Jeff. Não usa serviços pagos. Inicia tarefa; consulte concat_ai_job até completed. output deve ser caminho absoluto .wav novo em pasta existente. Texto até 4000 caracteres.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 4000 }, output: { type: 'string' }, voice: { type: 'string', enum: ['dora','alex','santa','jeff'] }, speed: { type: 'number', minimum: 0.5, maximum: 2 } }, required: ['text', 'output'], additionalProperties: false }, annotations: { destructiveHint: false, openWorldHint: false } },
  { name: 'concat_transcribe', description: 'Transcreve vídeo/áudio local com Whisper multilíngue e cria SRT, JSON e TXT. Inicia tarefa; consulte concat_ai_job. outputPrefix é caminho absoluto novo sem extensão em pasta existente. small tem melhor qualidade; base é mais rápido. Mantém áudio mono 16 kHz ao lado para conferência.', inputSchema: { type: 'object', properties: { input: { type: 'string' }, outputPrefix: { type: 'string' }, model: { type: 'string', enum: ['small', 'base'] }, language: { type: 'string', enum: ['pt','en','es','auto'] } }, required: ['input','outputPrefix'], additionalProperties: false }, annotations: { destructiveHint: false, openWorldHint: false } },
  { name: 'concat_ai_job', description: 'Consulta uma tarefa de voz/legenda desta conexão MCP. completed confirma arquivos verificados; failed contém motivo. IDs não persistem após reiniciar o MCP; os arquivos permanecem.', inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'], additionalProperties: false }, annotations: { readOnlyHint: true } }
];

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function inputFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Informe um caminho local absoluto.');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error('A entrada precisa ser um arquivo.');
  return canonical;
}
async function outputs(paths) {
  const normalized = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('A saída precisa ser um caminho absoluto.');
    await realpath(dirname(path));
    const key = resolve(path).toLowerCase();
    if (reservations.has(key) || await exists(path)) throw new Error('Saída já existe ou está em uso: '+path);
    normalized.push(key);
  }
  // Recheck reservations after asynchronous filesystem checks, before reserving.
  if (normalized.some(key => reservations.has(key))) throw new Error('Saída em uso por outra tarefa.');
  normalized.forEach(key => reservations.add(key));
  return () => normalized.forEach(key => reservations.delete(key));
}
async function run(exe, args, input) {
  await access(exe);
  return new Promise((resolveRun, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe','pipe','pipe'], shell: false });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input, 'utf8'); }
    let log = '';
    const append = chunk => { log = (log + chunk.toString('utf8')).slice(-16000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill(); }, 30 * 60 * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(log);
      else reject(new Error(`Motor local falhou (${code ?? signal}): ${log.slice(-6000)}`));
    });
  });
}
function start(kind, action, release) {
  // Keep finished job metadata bounded without interrupting running work.
  for (const [id, job] of jobs) if (jobs.size >= 32 && done.has(job.status)) jobs.delete(id);
  const job = { job: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString() };
  jobs.set(job.job, job);
  Promise.resolve().then(action).then(result => {
    Object.assign(job, { status: 'completed', result, finishedAt: new Date().toISOString() });
  }).catch(error => {
    Object.assign(job, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  }).finally(release);
  return { ...job };
}
async function waveInfo(path) {
  const bytes = await readFile(path);
  if (bytes.length < 44 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw new Error('Motor não produziu WAV válido.');
  return { output: path, bytes: bytes.length };
}
export async function speechCall(name, args = {}) {
  if (name === 'concat_ai_status') {
    const paths = { sherpa, voiceBridge, whisper, ffmpeg, voice: join(voice,'pt_BR-jeff-medium.onnx'), kokoro:join(kokoro,'model.int8.onnx'), whisperSmall: join(models,'whisper-models','ggml-small.bin'), whisperBase: join(models,'whisper-models','ggml-base.bin') };
    return { runtime, models, files: Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key,path]) => [key,{ path,installed:await exists(path) }]))) };
  }
  if (name === 'concat_ai_job') {
    const job = jobs.get(args.job);
    if (!job) throw new Error('Tarefa não encontrada nesta conexão. Confira os arquivos antes de repetir.');
    return { ...job };
  }
  if (name === 'concat_narrate') {
    const text = args.text?.trim();
    if (!text || text.length > 4000 || text.startsWith('-')) throw new Error('Texto inválido: use até 4000 caracteres e comece com uma palavra.');
    const speed = args.speed ?? 1;
    const selected = args.voice ?? 'dora';
    if (!['dora','alex','santa','jeff'].includes(selected)) throw new Error('Voz não permitida.');
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Velocidade deve estar entre 0.5 e 2.');
    if (!args.output?.toLowerCase().endsWith('.wav')) throw new Error('Escolha uma saída .wav.');
    const release = await outputs([args.output]);
    return start('narration-pt-BR', async () => {
      await run(voiceBridge, [selected === 'jeff' ? 'jeff' : 'kokoro', selected === 'jeff' ? voice : kokoro, resolve(dirname(sherpa),'..'), args.output, String({dora:42,alex:43,santa:44,jeff:0}[selected]), String(speed)], text);
      return { ...await waveInfo(args.output), voice: selected, language: 'pt-BR' };
    }, release);
  }
  if (name === 'concat_transcribe') {
    const input = await inputFile(args.input);
    const model = args.model ?? 'small';
    const language = args.language ?? 'pt';
    if (!['small','base'].includes(model) || !['pt','en','es','auto'].includes(language)) throw new Error('Modelo ou idioma não permitido.');
    const prefix = args.outputPrefix;
    if (typeof prefix !== 'string' || !isAbsolute(prefix)) throw new Error('Informe outputPrefix absoluto.');
    const wav = prefix + '.audio.wav';
    const release = await outputs([wav, prefix+'.srt', prefix+'.json', prefix+'.txt']);
    return start('transcription', async () => {
      await run(ffmpeg, ['-nostdin','-hide_banner','-loglevel','error','-n','-i',input,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
      await run(whisper, ['-m',join(models,'whisper-models',`ggml-${model}.bin`),'-f',wav,'-l',language,'-t','4','-osrt','-otxt','-oj','-of',prefix,'-ml','48','-sow']);
      for (const suffix of ['.srt','.json','.txt']) await access(prefix+suffix);
      const result = JSON.parse(await readFile(prefix+'.json','utf8'));
      return { srt:prefix+'.srt', json:prefix+'.json', textFile:prefix+'.txt', audio:wav, model, language, transcript:(await readFile(prefix+'.txt','utf8')).slice(0,40000), segments:(result.transcription ?? []).slice(0,500) };
    }, release);
  }
  throw new Error('Ferramenta de voz/legenda desconhecida.');
}
