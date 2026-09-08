import { EOL } from 'os'
import * as core from '../src/core'

describe('core helpers', () => {
  let stdout: jest.SpyInstance
  const originalExitCode = process.exitCode

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    delete process.env['INPUT_REPO-TOKEN']
    process.exitCode = undefined
  })

  afterEach(() => {
    stdout.mockRestore()
    process.exitCode = originalExitCode
  })

  test('gets and trims action inputs', () => {
    process.env['INPUT_REPO-TOKEN'] = '  token value  '
    expect(core.getInput('repo-token', { required: true })).toBe('token value')
    expect(core.getInput('repo-token', { trimWhitespace: false })).toBe(
      '  token value  '
    )
  })

  test('rejects a missing required input', () => {
    expect(() => core.getInput('repo-token', { required: true })).toThrow(
      'Input required and not supplied: repo-token'
    )
  })

  test('escapes workflow command data', () => {
    core.warning('50% complete\r\nnext')
    expect(stdout).toHaveBeenCalledWith(
      `::warning::50%25 complete%0D%0Anext${EOL}`
    )
  })

  test('sets a failure exit code and emits an escaped error command', () => {
    core.setFailed(new Error('bad%\nmessage'))
    expect(process.exitCode).toBe(1)
    expect(stdout).toHaveBeenCalledWith(
      `::error::Error: bad%25%0Amessage${EOL}`
    )
  })

  test('always closes an asynchronous log group', async () => {
    await expect(
      core.group('group%\nname', async () => {
        throw new Error('failure')
      })
    ).rejects.toThrow('failure')

    expect(stdout.mock.calls.map(([message]) => message)).toEqual([
      `::group::group%25%0Aname${EOL}`,
      `::endgroup::${EOL}`,
    ])
  })
})
