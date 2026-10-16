// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { ConcatClient } from './client.mjs';

const [method = 'version', argument = '{}'] = process.argv.slice(2);
const client = new ConcatClient();
try {
  const params = JSON.parse(argument.startsWith('@') ? await readFile(argument.slice(1), 'utf8') : argument);
  await client.connect();
  const result = await client.request(method, params, 60000);
  console.log(JSON.stringify(result, null, 2));
  if (method === 'export.run') {
    const done = await client.waitForExport(result.job, 15 * 60 * 1000);
    console.log(JSON.stringify(done, null, 2));
    if (done.method !== 'export.done') process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
