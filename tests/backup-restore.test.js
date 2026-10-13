import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('encrypted SQLite backup restores an integrity-checked copy without overwriting', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grounded-backup-test-'))
  const databasePath = path.join(directory, 'source.sqlite')
  const backupDirectory = path.join(directory, 'backups')
  const restoredPath = path.join(directory, 'restored.sqlite')
  const key = 'a'.repeat(64)
  const db = new Database(databasePath)
  db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO sample (label) VALUES ('synthetic test data');")
  db.close()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const backup = spawnSync(process.execPath, ['scripts/backup-db.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: databasePath, BACKUP_DIRECTORY: backupDirectory, BACKUP_ENCRYPTION_KEY: key },
  })
  assert.equal(backup.status, 0, backup.stderr)
  const files = await readdir(backupDirectory)
  assert.equal(files.length, 1)
  assert.match(files[0], /\.sqlite\.enc$/)
  const backupPath = path.join(backupDirectory, files[0])

  const restore = spawnSync(process.execPath, ['scripts/restore-db.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BACKUP_FILE: backupPath, RESTORE_DATABASE_PATH: restoredPath, BACKUP_ENCRYPTION_KEY: key, RESTORE_CONFIRM: 'YES' },
  })
  assert.equal(restore.status, 0, restore.stderr)
  const restored = new Database(restoredPath, { readonly: true })
  assert.equal(restored.pragma('integrity_check')[0].integrity_check, 'ok')
  assert.equal(restored.prepare('SELECT label FROM sample WHERE id = 1').get().label, 'synthetic test data')
  restored.close()

  const overwrite = spawnSync(process.execPath, ['scripts/restore-db.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BACKUP_FILE: backupPath, RESTORE_DATABASE_PATH: restoredPath, BACKUP_ENCRYPTION_KEY: key, RESTORE_CONFIRM: 'YES' },
  })
  assert.notEqual(overwrite.status, 0, 'restore must not overwrite an existing destination')
})
