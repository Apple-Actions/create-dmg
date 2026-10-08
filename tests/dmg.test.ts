import {beforeEach, describe, expect, it, vi} from 'vitest'
import {getExecOutput} from '@actions/exec'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {
  checkSignature,
  createImage,
  filterIdentities,
  parseIdentities,
  parsePemBundle,
  parseSignature,
  pickNewest,
  selectIdentity
} from '../src/dmg'

vi.mock('@actions/exec', () => ({getExecOutput: vi.fn()}))
vi.mock('@actions/core', () => ({info: vi.fn(), warning: vi.fn()}))

const execOutput = vi.mocked(getExecOutput)
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

const OLDER = '228DB28F73E1F5FC0F5E1351E1EFE33235B3268B'
const NEWER = 'AB756E2BD9CECCE343DDB291FF45FC531E2EE1F7'
const NAME = 'Developer ID Application: Test (ABCDE12345)'

const DEVELOPER_ID_SIGNATURE = `Executable=/tmp/App.app/Contents/MacOS/App
Identifier=com.example.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded
Signature size=9045
Authority=Developer ID Application: Example Corp (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 8, 2026 at 5:00:00 PM
Info.plist entries=20
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=3
Internal requirements count=1 size=180`

const ADHOC_SIGNATURE = `Executable=/tmp/App.app/Contents/MacOS/App
Identifier=App
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=500 flags=0x2(adhoc) hashes=12+7 location=embedded
Signature=adhoc
Info.plist entries=6
TeamIdentifier=not set`

type Output = {exitCode?: number; stdout?: string; stderr?: string}

function respond(...outputs: Output[]): void {
  for (const out of outputs) {
    execOutput.mockResolvedValueOnce({
      exitCode: out.exitCode ?? 0,
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? ''
    })
  }
}

beforeEach(() => {
  execOutput.mockReset()
})

describe('parseSignature', () => {
  it('reads the leaf authority and team', () => {
    expect(parseSignature(DEVELOPER_ID_SIGNATURE)).toEqual({
      authority: 'Developer ID Application: Example Corp (ABCDE12345)',
      teamId: 'ABCDE12345'
    })
  })

  it('treats "not set" as no team', () => {
    expect(parseSignature(ADHOC_SIGNATURE)).toEqual({
      authority: undefined,
      teamId: undefined
    })
  })
})

describe('checkSignature', () => {
  it('returns the app team', () => {
    expect(
      checkSignature('App.app', parseSignature(DEVELOPER_ID_SIGNATURE))
    ).toBe('ABCDE12345')
  })

  it('rejects an ad-hoc signature', () => {
    expect(() =>
      checkSignature('App.app', parseSignature(ADHOC_SIGNATURE))
    ).toThrow('App.app is not signed with Developer ID')
  })

  it('rejects an App Store signature', () => {
    const sig = {
      authority: 'Apple Distribution: Example Corp (ABCDE12345)',
      teamId: 'ABCDE12345'
    }
    expect(() => checkSignature('App.app', sig)).toThrow(
      'Export the app with the developer-id method'
    )
  })

  it('rejects a team-id mismatch', () => {
    expect(() =>
      checkSignature(
        'App.app',
        parseSignature(DEVELOPER_ID_SIGNATURE),
        'ZZZZZ99999'
      )
    ).toThrow('signed by team ABCDE12345, but `team-id` is ZZZZZ99999')
  })

  it('falls back to the team in the certificate name', () => {
    expect(checkSignature('App.app', {authority: NAME})).toBe('ABCDE12345')
  })
})

describe('identities', () => {
  const all = parseIdentities(fixture('find-identity.txt'))

  it('parses find-identity output', () => {
    expect(all).toHaveLength(4)
    expect(all[0]).toEqual({hash: OLDER, name: NAME})
  })

  it('keeps Developer ID identities for the team', () => {
    expect(
      filterIdentities(all, {teamId: 'ABCDE12345'}).map(id => id.hash)
    ).toEqual([OLDER, NEWER])
  })

  it('matches an exact name when given', () => {
    expect(
      filterIdentities(all, {
        name: 'Apple Distribution: Test (ABCDE12345)',
        teamId: 'ABCDE12345'
      }).map(id => id.hash)
    ).toEqual(['1111111111111111111111111111111111111111'])
  })

  it('picks the certificate that expires last', () => {
    const certs = parsePemBundle(fixture('find-certificate.txt'))
    expect([...certs.keys()]).toEqual([OLDER, NEWER])
    const candidates = filterIdentities(all, {teamId: 'ABCDE12345'})
    expect(pickNewest(candidates, certs).identity.hash).toBe(NEWER)
    expect(pickNewest([...candidates].reverse(), certs).identity.hash).toBe(
      NEWER
    )
  })
})

describe('selectIdentity', () => {
  it('uses a SHA-1 hash as-is', async () => {
    expect(
      await selectIdentity({signingIdentity: NEWER.toLowerCase(), teamId: 'X'})
    ).toBe(NEWER)
    expect(execOutput).not.toHaveBeenCalled()
  })

  it('signs with the newest of identities sharing a name', async () => {
    respond(
      {stdout: fixture('find-identity.txt')},
      {stdout: fixture('find-certificate.txt')}
    )
    expect(
      await selectIdentity({teamId: 'ABCDE12345', keychain: 'ci.keychain-db'})
    ).toBe(NEWER)
    expect(execOutput.mock.calls[0][1]).toEqual([
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      'ci.keychain-db'
    ])
    expect(execOutput.mock.calls[1][1]).toEqual([
      'find-certificate',
      '-a',
      '-c',
      NAME,
      '-Z',
      '-p',
      'ci.keychain-db'
    ])
  })

  it('returns a single match without reading certificates', async () => {
    respond({stdout: fixture('find-identity.txt')})
    expect(await selectIdentity({teamId: 'ZZZZZ99999'})).toBe(
      '2222222222222222222222222222222222222222'
    )
    expect(execOutput).toHaveBeenCalledTimes(1)
  })

  it('lists what it found when nothing matches', async () => {
    respond({stdout: fixture('find-identity.txt')})
    await expect(selectIdentity({teamId: 'NOPE000000'})).rejects.toThrow(
      /matches "Developer ID Application: \.\.\. \(NOPE000000\)"[\s\S]*2222222222222222222222222222222222222222[\s\S]*import-codesign-certs/
    )
  })
})

describe('createImage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  async function rejects(message: string): Promise<void> {
    const result = expect(createImage(['-ov', 'App.dmg'])).rejects.toThrow(
      message
    )
    await vi.runAllTimersAsync()
    await result
  }

  it('retries when the resource is busy', async () => {
    respond(
      {exitCode: 16, stderr: 'hdiutil: create failed - Resource busy'},
      {exitCode: 0}
    )
    const result = createImage(['-ov', 'App.dmg'])
    await vi.runAllTimersAsync()
    await result
    expect(execOutput).toHaveBeenCalledTimes(2)
  })

  it('does not retry other failures', async () => {
    respond({exitCode: 1, stderr: 'hdiutil: create failed - No space'})
    await rejects('hdiutil create failed (exit 1)')
    expect(execOutput).toHaveBeenCalledTimes(1)
  })

  it('gives up after its attempts are used up', async () => {
    const busy = {exitCode: 16, stderr: 'Resource busy'}
    respond(busy, busy, busy)
    await rejects('hdiutil create still busy after 3 attempts')
    expect(execOutput).toHaveBeenCalledTimes(3)
  })
})
