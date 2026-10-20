// Copy to the pinned Mailflare checkout. Exercises its real pruning function.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
const require = createRequire(join(process.env.MAILFLARE_CHECKOUT, 'package.json'));
const { build } = require('esbuild');
const output = join(process.env.PILOT_DATA_DIR, 'jmap-bundle.mjs');

await build({
  stdin: {
    contents: `
      import assert from 'node:assert/strict';
      import { openSqliteDatabase } from './server/runtime/sqlite-database';
      import { getDb } from './src/db';
      import { pruneJmapChanges } from './src/lib/jmap/changes';
      import { processOutboundQueue } from './src/lib/email/send';
      export async function test() {
        const adapter = openSqliteDatabase(process.env.PILOT_DATA_DIR + '/mailflare.sqlite');
        try {
          const db = getDb({DB: adapter});
          const job = adapter.db.prepare("SELECT id FROM outbound_jobs WHERE status='sent' AND payload='{}'").get();
          assert.ok(job);
          // A duplicate queue delivery must return before parsing minimized input.
          await processOutboundQueue({DB: adapter}, {
            kind:'email.scheduled', jobId:job.id, messageId:'deleted-synthetic',
            scheduledAt:new Date().toISOString()
          });
          assert.equal(adapter.db.prepare('SELECT status FROM outbound_jobs WHERE id=?').get(job.id).status,'sent');
          for (const retained of adapter.db.prepare("SELECT id,payload FROM outbound_jobs WHERE status='sent' AND payload<>'{}'").all()) {
            await processOutboundQueue({DB: adapter}, {
              kind:'email.scheduled', jobId:retained.id, messageId:'synthetic-cleanup-failure',
              scheduledAt:new Date().toISOString()
            });
            assert.equal(adapter.db.prepare('SELECT payload FROM outbound_jobs WHERE id=?').get(retained.id).payload,retained.payload);
          }
          const before = adapter.db.prepare('SELECT count(*) n FROM jmap_changes').get().n;
          assert.ok(before > 0);
          assert.equal(await pruneJmapChanges(db, Date.now()), 0);
          assert.equal(adapter.db.prepare('SELECT count(*) n FROM jmap_changes').get().n, before);
          const deleted = await pruneJmapChanges(db, Date.now() + 31*86400000);
          assert.equal(deleted, before);
          assert.equal(adapter.db.prepare('SELECT count(*) n FROM jmap_changes').get().n, 0);
          assert.ok(adapter.db.prepare('SELECT seq FROM jmap_change_floor WHERE id=1').get().seq > 0);
          assert.equal(await pruneJmapChanges(db, Date.now() + 31*86400000), 0);
          return {recent_changes_preserved:true, expired_changes_removed:deleted,
            resync_floor_advanced:true, repeat_deleted:0, minimized_job_not_replayed:true};
        } finally {adapter.db.close();}
      }`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: output,
  tsconfig: 'tsconfig.json',
  external: ['better-sqlite3', 'nodemailer', 'smtp-server'],
  banner: {js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},
  alias: {'cloudflare:workers': './server/runtime/cloudflare-workers.ts'},
});
const { test } = await import(pathToFileURL(resolve(output)).href);
const result = await test();
writeFileSync(join(process.env.PILOT_DATA_DIR, 'jmap-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
