// C0 persistence smoke test: covers the node:sqlite APIs the Runtime relies on
// (Stability 1.2 in Node 24): file DB, WAL, prepared statements, BLOB, explicit
// transactions with rollback, and reopening after close.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('node:sqlite supports the Runtime persistence pattern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-sqlite-'));
  try {
    const file = join(dir, 'smoke.sqlite');
    let db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, bytes BLOB)');
    const insert = db.prepare('INSERT INTO t (doc, bytes) VALUES (?, ?)');
    db.exec('BEGIN IMMEDIATE');
    insert.run(JSON.stringify({v: 1}), new Uint8Array([137, 80, 78, 71]));
    db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    insert.run('{"v":2}', null);
    db.exec('ROLLBACK');
    db.close();
    db = new DatabaseSync(file);
    const rows = db.prepare('SELECT doc, bytes FROM t').all() as {doc: string; bytes: Uint8Array}[];
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].doc), {v: 1});
    assert.deepEqual([...rows[0].bytes], [137, 80, 78, 71]);
    db.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
