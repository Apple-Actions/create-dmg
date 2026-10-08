import {info, warning} from '@actions/core'
import {getExecOutput} from '@actions/exec'
import {X509Certificate} from 'node:crypto'

interface Identity {
  hash: string
  name: string
}

interface Signature {
  authority?: string
  teamId?: string
}

export const FORMATS = ['UDZO', 'ULFO', 'ULMO', 'UDBZ'] as const

const DEVELOPER_ID = 'Developer ID Application:'
const SHA1 = /^[0-9A-Fa-f]{40}$/

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const keychainArgs = (keychain?: string): string[] =>
  keychain ? [keychain] : []

export function parseSignature(text: string): Signature {
  // codesign lists the chain leaf first.
  const authority = /^Authority=(.+)$/m.exec(text)?.[1].trim()
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1].trim()
  return {authority, teamId: team && team !== 'not set' ? team : undefined}
}

export function checkSignature(
  appPath: string,
  sig: Signature,
  teamIdInput?: string
): string {
  if (!sig.authority?.startsWith(DEVELOPER_ID)) {
    throw new Error(
      `${appPath} is not signed with Developer ID (Authority: ${sig.authority ?? 'none, ad-hoc or unsigned'}). ` +
        'Notarization will reject it. Export the app with the developer-id method.'
    )
  }
  // Non-Apple certificates leave TeamIdentifier unset, so fall back to the
  // "(TEAMID)" suffix of the certificate name.
  const appTeam = sig.teamId ?? /\(([A-Z0-9]+)\)$/.exec(sig.authority)?.[1]
  if (teamIdInput && appTeam && teamIdInput !== appTeam) {
    throw new Error(
      `${appPath} is signed by team ${appTeam}, but \`team-id\` is ${teamIdInput}`
    )
  }
  const team = teamIdInput || appTeam
  if (!team) {
    throw new Error(
      `Could not read the team ID from ${appPath}'s signature; set \`team-id\``
    )
  }
  return team
}

export async function verifyApp(appPath: string): Promise<Signature> {
  const verify = await getExecOutput(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    {ignoreReturnCode: true}
  )
  if (verify.exitCode !== 0) {
    throw new Error(
      `codesign --verify failed for ${appPath}: ${`${verify.stdout}\n${verify.stderr}`.trim()}`
    )
  }
  const display = await getExecOutput('codesign', ['-dvv', appPath], {
    ignoreReturnCode: true,
    silent: true
  })
  return parseSignature(`${display.stdout}\n${display.stderr}`)
}

export function parseIdentities(text: string): Identity[] {
  const seen = new Map<string, Identity>()
  for (const match of text.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"/gm)) {
    seen.set(match[1], {hash: match[1], name: match[2]})
  }
  return [...seen.values()]
}

export function filterIdentities(
  identities: Identity[],
  filter: {name?: string; teamId: string}
): Identity[] {
  return identities.filter(id =>
    filter.name
      ? id.name === filter.name
      : id.name.startsWith(DEVELOPER_ID) &&
        id.name.endsWith(`(${filter.teamId})`)
  )
}

export function parsePemBundle(text: string): Map<string, X509Certificate> {
  const certs = new Map<string, X509Certificate>()
  const pattern =
    /SHA-1 hash: ([0-9A-F]{40})\s+(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/g
  for (const match of text.matchAll(pattern)) {
    certs.set(match[1], new X509Certificate(match[2]))
  }
  return certs
}

export function pickNewest(
  candidates: Identity[],
  certs: Map<string, X509Certificate>
): {identity: Identity; expires: Date} {
  let best: {identity: Identity; expires: Date} | undefined
  for (const identity of candidates) {
    const cert = certs.get(identity.hash)
    if (!cert) {
      warning(`No certificate found for ${identity.hash} (${identity.name})`)
      continue
    }
    const expires = new Date(cert.validTo)
    if (!best || expires > best.expires) best = {identity, expires}
  }
  if (!best) {
    throw new Error(
      `Could not read the certificates for ${candidates.map(c => c.hash).join(', ')}`
    )
  }
  return best
}

export async function selectIdentity(options: {
  signingIdentity?: string
  teamId: string
  keychain?: string
}): Promise<string> {
  const {signingIdentity, teamId, keychain} = options
  if (signingIdentity && SHA1.test(signingIdentity)) {
    return signingIdentity.toUpperCase()
  }

  const out = await getExecOutput(
    'security',
    ['find-identity', '-v', '-p', 'codesigning', ...keychainArgs(keychain)],
    {silent: true}
  )
  const all = parseIdentities(out.stdout)
  const matches = filterIdentities(all, {name: signingIdentity, teamId})

  if (matches.length === 0) {
    const wanted = signingIdentity
      ? `"${signingIdentity}"`
      : `"${DEVELOPER_ID} ... (${teamId})"`
    const found = all.length
      ? all.map(id => `  ${id.hash} "${id.name}"`).join('\n')
      : '  (none)'
    throw new Error(
      `No valid code signing identity matches ${wanted}. Found:\n${found}\n` +
        'Import a Developer ID Application certificate first, for example with Apple-Actions/import-codesign-certs.'
    )
  }
  if (matches.length === 1) {
    info(`Signing with ${matches[0].hash} (${matches[0].name})`)
    return matches[0].hash
  }

  // A renewed certificate keeps its name, so pick the one that expires last.
  let pem = ''
  for (const name of new Set(matches.map(id => id.name))) {
    const certs = await getExecOutput(
      'security',
      [
        'find-certificate',
        '-a',
        '-c',
        name,
        '-Z',
        '-p',
        ...keychainArgs(keychain)
      ],
      {silent: true}
    )
    pem += `${certs.stdout}\n`
  }
  const {identity, expires} = pickNewest(matches, parsePemBundle(pem))
  info(
    `${matches.length} identities match: ${matches.map(id => id.hash).join(', ')}. ` +
      `Signing with ${identity.hash} (${identity.name}), which expires last (${expires.toISOString()}).`
  )
  return identity.hash
}

export async function createImage(args: string[], attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const out = await getExecOutput('hdiutil', ['create', ...args], {
      ignoreReturnCode: true
    })
    if (out.exitCode === 0) return
    const text = `${out.stdout}\n${out.stderr}`.trim()
    if (out.exitCode !== 16 && !text.includes('Resource busy')) {
      throw new Error(`hdiutil create failed (exit ${out.exitCode}): ${text}`)
    }
    if (attempt >= attempts) {
      throw new Error(
        `hdiutil create still busy after ${attempts} attempts: ${text}`
      )
    }
    warning(
      `hdiutil create attempt ${attempt} failed with Resource busy; retrying`
    )
    await sleep(2_000 * attempt)
  }
}
