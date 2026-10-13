import Database from 'better-sqlite3'
import { createCipheriv, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const databasePath = process.env.DATABASE_PATH
const backupDirectory = process.env.BACKUP_DIRECTORY || path.resolve('backups')
const keyHex = process.env.BACKUP_ENCRYPTION_KEY || ''

if (!databasePath) throw new Error('DATABASE_PATH must identify the SQLite database to back up.')
if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes).')
const key = Buffer.from(keyHex, 'hex')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const suffix = randomBytes(4).toString('hex')
const outputPath = path.join(backupDirectory, 'grounded-' + timestamp + '-' + suffix + '.sqlite.enc')
const temporaryOutputPath = outputPath + '.partial'
const magic = Buffer.from('GRDBAK1')
const iv = randomBytes(12)

await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'grounded-backup-'))
const temporaryDatabase = path.join(temporaryDirectory, 'snapshot.sqlite')
let published = false
try {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    await db.backup(temporaryDatabase)
  } finally {
    db.close()
  }
  await writeFile(temporaryOutputPath, Buffer.concat([magic, iv]), { flag: 'wx', mode: 0o600 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  await pipeline(createReadStream(temporaryDatabase), cipher, createWriteStream(temporaryOutputPath, { flags: 'a', mode: 0o600 }))
  await appendFile(temporaryOutputPath, cipher.getAuthTag())
  await rename(temporaryOutputPath, outputPath)
  published = true
  console.log('Encrypted database backup created:', outputPath)
} finally {
  if (!published) await rm(temporaryOutputPath, { force: true })
  await rm(temporaryDirectory, { recursive: true, force: true })
}
