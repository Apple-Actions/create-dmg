import {
  getBooleanInput,
  getInput,
  info,
  setFailed,
  setOutput
} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {
  FORMATS,
  checkSignature,
  createImage,
  selectIdentity,
  signDmg,
  verifyApp
} from './dmg'

async function run(): Promise<void> {
  try {
    await main()
  } catch (err) {
    setFailed(err instanceof Error ? err.message : String(err))
  }
}

async function volumeName(appPath: string, appName: string): Promise<string> {
  const out = await getExecOutput(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleName', join(appPath, 'Contents', 'Info.plist')],
    {ignoreReturnCode: true, silent: true}
  )
  return (out.exitCode === 0 && out.stdout.trim()) || appName
}

async function main(): Promise<void> {
  const appInput = getInput('app-path', {required: true})
  const dmgInput = getInput('dmg-path')
  const volumeInput = getInput('volume-name')
  const signingIdentity = getInput('signing-identity') || undefined
  const teamIdInput = getInput('team-id') || undefined
  const keychain = getInput('keychain') || undefined
  const applicationsLink = getBooleanInput('applications-link')
  const format = getInput('format') || 'UDZO'

  const appPath = resolve(appInput)
  if (!appPath.endsWith('.app')) {
    throw new Error(`\`app-path\` must end in .app: ${appInput}`)
  }
  if (!existsSync(appPath)) throw new Error(`Not found: ${appInput}`)
  if (process.platform !== 'darwin') {
    throw new Error(
      `create-dmg must run on a macOS runner (this one is ${process.platform})`
    )
  }
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `\`format\` must be one of ${FORMATS.join(', ')}: ${format}`
    )
  }

  const signature = await verifyApp(appPath)
  const teamId = checkSignature(appInput, signature, teamIdInput)
  info(`${appInput} is signed by ${signature.authority}`)

  const hash = await selectIdentity({signingIdentity, teamId, keychain})

  const appName = basename(appPath, '.app')
  const volume = volumeInput || (await volumeName(appPath, appName))
  const dmgPath = resolve(dmgInput || join(dirname(appPath), `${appName}.dmg`))

  const staging = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'create-dmg-')
  )
  try {
    // ditto keeps framework symlinks, extended attributes, and the signature.
    await exec('ditto', [appPath, join(staging, basename(appPath))])
    if (applicationsLink) {
      symlinkSync('/Applications', join(staging, 'Applications'))
    }

    mkdirSync(dirname(dmgPath), {recursive: true})
    await createImage([
      '-format',
      format,
      '-volname',
      volume,
      '-srcfolder',
      staging,
      '-ov',
      dmgPath
    ])

    await signDmg(hash, dmgPath, keychain)
    await exec('codesign', ['--verify', '--strict', dmgPath])

    setOutput('dmg-path', dmgPath)
    setOutput('signing-identity', hash)
    info(`Created ${dmgPath} (volume "${volume}"), signed with ${hash}`)
  } finally {
    rmSync(staging, {recursive: true, force: true})
  }
}

run()
