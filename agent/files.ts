// File manager operations. Each one runs as the account's own Linux user (runuser), so the
// kernel decides what may be read or changed; the paths are also kept inside the home folder.
import { existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { type Args, homePath, must, runAs, username } from './lib.ts'

const STAGING = process.env.WEBCPL_UPLOADS ?? '/var/lib/webcpl/uploads'
const MAX_READ = 5 * 1024 * 1024
const MAX_DOWNLOAD = 64 * 1024 * 1024

function target(args: Args, key = 'path') {
  const user = username(args)
  return { user, path: homePath(user, args[key]) }
}

/** A name for something inside a folder: no slashes, not "." or "..". */
function leafName(value: unknown) {
  const name = String(value ?? '').trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name.length > 255) throw new Error('Invalid name.')
  return name
}

export const fileOps: Record<string, (args: Args) => Promise<unknown>> = {
  'files.list': async (args) => {
    const { user, path } = target(args)
    const result = await runAs(user, ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%s\t%T@\t%m\t%u\t%l\t%f\n'])
    if (!result.ok) throw new Error(result.stderr.includes('Permission denied') ? 'You do not have access to that folder.' : 'That folder does not exist.')
    const entries = result.stdout.split('\n').filter(Boolean).map((line) => {
      const [type, size, mtime, mode, owner, link, ...name] = line.split('\t')
      return {
        name: name.join('\t'),
        type: type === 'd' ? 'dir' : type === 'l' ? 'link' : 'file',
        size: Number(size),
        modified: Math.round(Number(mtime) * 1000),
        mode: mode!.padStart(3, '0'),
        owner,
        target: link || null,
      }
    })
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
    return { path: path.replace(`/home/${user}`, '') || '/', entries }
  },

  'files.read': async (args) => {
    const { user, path } = target(args)
    const size = await runAs(user, ['stat', '-c', '%s', path])
    if (!size.ok) throw new Error('That file cannot be opened.')
    if (Number(size.stdout) > MAX_READ) throw new Error('This file is too large to edit here (5 MB at most).')
    const result = await runAs(user, ['cat', '--', path])
    if (!result.ok) throw new Error('That file cannot be opened.')
    return { content: result.stdout }
  },

  'files.write': async (args) => {
    const { user, path } = target(args)
    const content = String(args.content ?? '')
    if (content.length > MAX_READ) throw new Error('This file is too large to save here (5 MB at most).')
    const result = await runAs(user, ['tee', '--', path], { input: content })
    if (!result.ok) throw new Error('The file could not be saved.')
    return { ok: true }
  },

  'files.mkdir': async (args) => {
    const { user, path } = target(args)
    await must(['runuser', '-u', user, '--', 'mkdir', '--', `${path}/${leafName(args.name)}`], 'The folder could not be created')
    return { ok: true }
  },

  'files.create': async (args) => {
    const { user, path } = target(args)
    const file = `${path}/${leafName(args.name)}`
    const exists = await runAs(user, ['test', '-e', file])
    if (exists.ok) throw new Error('Something with that name already exists.')
    await must(['runuser', '-u', user, '--', 'touch', '--', file], 'The file could not be created')
    return { ok: true }
  },

  'files.rename': async (args) => {
    const { user, path } = target(args)
    const to = homePath(user, args.to)
    await must(['runuser', '-u', user, '--', 'mv', '-n', '--', path, to], 'It could not be moved')
    return { ok: true }
  },

  'files.copy': async (args) => {
    const { user, path } = target(args)
    const to = homePath(user, args.to)
    await must(['runuser', '-u', user, '--', 'cp', '-a', '-n', '--', path, to], 'It could not be copied', { timeout: 600_000 })
    return { ok: true }
  },

  'files.delete': async (args) => {
    const user = username(args)
    const paths = ((args.paths ?? []) as unknown[]).map((p) => homePath(user, p))
    if (paths.some((p) => p === `/home/${user}`)) throw new Error('The home folder itself cannot be deleted.')
    await must(['runuser', '-u', user, '--', 'rm', '-rf', '--', ...paths], 'It could not be deleted', { timeout: 600_000 })
    return { ok: true }
  },

  'files.chmod': async (args) => {
    const { user, path } = target(args)
    const mode = String(args.mode ?? '')
    if (!/^[0-7]{3}$/.test(mode)) throw new Error('Use a mode like 644 or 755.')
    await must(['runuser', '-u', user, '--', 'chmod', mode, '--', path], 'The permissions could not be changed')
    return { ok: true }
  },

  /** Moves a file the panel received into the account, as the account's user. */
  'files.upload': async (args) => {
    const { user, path } = target(args)
    const staged = String(args.staged ?? '')
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(staged)) throw new Error('Invalid upload.')
    const source = `${STAGING}/${staged}`
    if (!existsSync(source)) throw new Error('The upload was not found.')
    try {
      const destination = `${path}/${leafName(args.name)}`
      const result = await runAs(user, ['tee', '--', destination], { input: Bun.file(source), timeout: 600_000 })
      if (!result.ok) throw new Error(result.stderr.includes('Disk quota') ? 'The account is out of disk space.' : 'The file could not be saved there.')
      return { ok: true }
    } finally {
      rmSync(source, { force: true })
    }
  },

  'files.download': async (args) => {
    const { user, path } = target(args)
    const size = await runAs(user, ['stat', '-c', '%s', path])
    if (!size.ok) throw new Error('That file cannot be opened.')
    if (Number(size.stdout) > MAX_DOWNLOAD) throw new Error('Download files of up to 64 MB here; use SFTP for larger ones.')
    const proc = Bun.spawn(['runuser', '-u', user, '--', 'cat', '--', path], { stdout: 'pipe', stderr: 'ignore' })
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    if ((await proc.exited) !== 0) throw new Error('That file cannot be opened.')
    return { name: basename(path), base64: Buffer.from(bytes).toString('base64') }
  },

  'files.extract': async (args) => {
    const { user, path } = target(args)
    const into = homePath(user, args.into)
    const cmd = /\.zip$/i.test(path)
      ? ['unzip', '-o', '-q', path, '-d', into]
      : /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(path)
        ? ['tar', '-xf', path, '-C', into, '--no-same-owner']
        : null
    if (!cmd) throw new Error('Only .zip and .tar(.gz, .xz, .bz2) archives can be extracted here.')
    await must(['runuser', '-u', user, '--', ...cmd], 'The archive could not be extracted', { timeout: 900_000 })
    return { ok: true }
  },

  'files.compress': async (args) => {
    const user = username(args)
    const folder = homePath(user, args.folder)
    const names = ((args.names ?? []) as unknown[]).map(leafName)
    const archive = leafName(args.archive)
    if (!names.length) throw new Error('Choose what to compress.')
    if (!archive.endsWith('.zip')) throw new Error('The archive name must end with .zip.')
    const result = await runAs(user, ['sh', '-c', 'cd "$1" && shift && zip -r -q "$@"', 'zip', folder, archive, ...names], { timeout: 900_000 })
    if (!result.ok) throw new Error('The archive could not be created.')
    return { ok: true }
  },
}

