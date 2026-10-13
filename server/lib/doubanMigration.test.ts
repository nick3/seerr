import DoubanBinding from '@server/entity/DoubanBinding';
import { AddDoubanBinding1791849600000 } from '@server/migration/sqlite/1791849600000-AddDoubanBinding';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { DataSource } from 'typeorm';

it('migrates existing data, persists bindings across restart, and rolls back only the binding table', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seerr-douban-db-'));
  const db = new DataSource({
    type: 'sqlite',
    database: path.join(directory, 'test.sqlite3'),
    entities: [DoubanBinding],
    migrations: [AddDoubanBinding1791849600000],
  });
  try {
    await db.initialize();
    await db.query('CREATE TABLE existing_data (id integer PRIMARY KEY)');
    await db.query('INSERT INTO existing_data VALUES (1)');
    await db.runMigrations();
    await db.getRepository(DoubanBinding).save({
      mediaType: 'tv',
      tmdbId: 65733,
      doubanId: '3538051',
      source: 'manual',
    });
    await db.destroy();
    await db.initialize();
    assert.equal(
      (
        await db
          .getRepository(DoubanBinding)
          .findOneByOrFail({ mediaType: 'tv', tmdbId: 65733 })
      ).doubanId,
      '3538051'
    );
    assert.equal(
      (await db.driver.createSchemaBuilder().log()).upQueries.length,
      0
    );
    await db.undoLastMigration();
    assert.deepEqual(await db.query('SELECT * FROM existing_data'), [
      { id: 1 },
    ]);
    assert.equal(
      await db.createQueryRunner().hasTable('douban_binding'),
      false
    );
  } finally {
    if (db.isInitialized) await db.destroy();
    await rm(directory, { recursive: true });
  }
});
