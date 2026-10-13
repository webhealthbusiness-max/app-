import Database from 'better-sqlite3'
import { createDecipheriv } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const backupPath = process.env.BACKUP_FILE
const destinationPath = process.env.RESTORE_DATABASE_PATH
const keyHex = process.env.BACKUP_ENCRYPTION_KEY || ''
if (!backupPath || !destinationPath) throw new Error('Set BACKUP_FILE and RESTORE_DATABASE_PATH.')
if (process.env.RESTORE_CONFIRM !== 'YES') throw new Error('Set RESTORE_CONFIRM=YES after reviewing the destination; restore never overwrites an existing file.')
if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes).')
const sourceStat = await stat(backupPath)
const headerLength = 7 + 12
const tagLength = 16
if (sourceStat.size <= headerLength + tagLength) throw new Error('Backup is too small or truncated.')
const file = await open(backupPath, 'r')
const header = Buffer.alloc(headerLength)
const tag = Buffer.alloc(tagLength)
try {
  await file.read(header, 0, headerLength, 0)
  await file.read(tag, 0, tagLength, sourceStat.size - tagLength)
} finally {
  await file.close()
}
if (header.subarray(0, 7).toString() !== 'GRDBAK1') throw new Error('Unknown backup format.')
const iv = header.subarray(7, 19)
const key = Buffer.from(keyHex, 'hex')
const temporaryRestore = path.join(os.tmpdir(), 'grounded-restore-' + process.pid + '-' + Date.now() + '.sqlite')
await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(path.resolve(destinationPath)), { recursive: true }))
try {
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  await pipeline(createReadStream(backupPath, { start: headerLength, end: sourceStat.size - tagLength - 1 }), decipher, createWriteStream(temporaryRestore, { flags: 'wx', mode: 0o600 }))
  const check = new Database(temporaryRestore, { readonly: true, fileMustExist: true })
  try {
    const result = check.pragma('integrity_check')
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('Restored database failed SQLite integrity_check.')
  } finally {
    check.close()
  }
  await writeFile(destinationPath, await (await import('node:fs/promises')).readFile(temporaryRestore), { flag: 'wx', mode: 0o600 })
  console.log('Backup decrypted and integrity-checked. Restored database written to:', destinationPath)
} finally {
  await rm(temporaryRestore, { force: true })
}
