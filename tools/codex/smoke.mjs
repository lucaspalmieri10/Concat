// SPDX-License-Identifier: AGPL-3.0-or-later
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outputDir = join(root, '.local', 'verification');
const location = join(root, 'projects');
const projectName = 'CONCAT_CODEX_TESTE_' + new Date().toISOString().replace(/[:.]/g, '-');
const projectPath = join(location, projectName);
const output = join(outputDir, projectName + '.mp4');
const preview = join(outputDir, projectName + '.png');
await mkdir(outputDir, { recursive: true });
await mkdir(location, { recursive: true });
const client = new Client({ name: 'concat-verification', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'pipe' });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const report = { projectPath, output, preview, checks: [] };
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  if (result.content[0]?.type === 'image') return result.content[0];
  return JSON.parse(result.content[0].text);
}
const edit = (method, params) => call('concat_edit', { method, params });
try {
  await client.connect(transport);
  report.tools = (await client.listTools()).tools.map(tool => tool.name);
  await call('concat_start');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { report.version = await call('concat_status'); break; }
    catch (error) { if (attempt === 19) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  report.checks.push('MCP initialize, tools/list and authenticated version');
  const invalid = await client.callTool({ name: 'concat_read', arguments: { method: 'project.save', params: { path: projectPath } } });
  assert.equal(invalid.isError, true);
  report.checks.push('Read tool refuses write methods');
  await edit('project.create', { location, name: projectName, video: { width: 720, height: 1280, rateNum: 30, rateDen: 1 } });
  await edit('edit.apply', { path: projectPath, command: { op: 'batch', commands: [
    { op: 'addTextClip', start: 0, duration: 4, above: true, offsetY: -0.08, style: { content: 'CONCAT\n+ CODEX', fontSize: 0.075, fontWeight: 800, color: '#74f0b7', maxWidth: 0.9 } },
    { op: 'addTextClip', start: 0, duration: 4, above: true, offsetY: 0.14, style: { content: 'EDIÇÃO LOCAL\nConexão validada', fontSize: 0.027, fontWeight: 500, color: '#ffffff', maxWidth: 0.9 } }
  ] } });
  await edit('project.save', { path: projectPath });
  const document = JSON.parse(await readFile(join(projectPath, 'concat.json'), 'utf8'));
  assert.ok(JSON.stringify(document).includes('Conexão validada'));
  report.checks.push('Create vertical project, apply titles, save and reread document');
  const image = await call('concat_preview', { path: projectPath, time: 1, width: 360, height: 640 });
  assert.equal(image.type, 'image');
  await writeFile(preview, Buffer.from(image.data, 'base64'));
  report.checks.push('Preview PNG returned through MCP');
  let exported = await call('concat_export', { path: projectPath, output, width: 720, height: 1280, preset: 'veryfast', crf: 22 });
  if (exported.event.method === 'export.pending') {
    for (let tries = 0; tries < 30; tries++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const events = await call('concat_events', { job: exported.started.job });
      const terminal = events.events.find(event => ['export.done', 'export.failed'].includes(event.method));
      if (terminal) { exported.event = terminal; break; }
    }
  }
  assert.equal(exported.event.method, 'export.done', JSON.stringify(exported));
  report.export = exported;
  report.outputBytes = (await stat(output)).size;
  assert.ok(report.outputBytes > 1000);
  report.probe = await call('concat_read', { method: 'media.probe', params: { path: output } });
  assert.equal(report.probe.video.width, 720);
  assert.equal(report.probe.video.height, 1280);
  assert.equal(report.probe.video.codec, 'h264');
  assert.equal(report.probe.duration, 4);
  report.checks.push('MP4 export completed and independently probed at 720x1280');
  const duplicate = await client.callTool({ name: 'concat_export', arguments: { path: projectPath, output } });
  assert.equal(duplicate.isError, true);
  report.checks.push('Existing export file is protected from overwrite');
  await edit('project.close', { path: projectPath, save: true });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await client.close();
  await writeFile(join(outputDir, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
