import { EOL } from 'os'

export interface InputOptions {
  required?: boolean
  trimWhitespace?: boolean
}

function toCommandValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string' || value instanceof String) {
    return value as string
  }
  return JSON.stringify(value)
}

export function escapeData(value: unknown): string {
  return toCommandValue(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

function issueCommand(command: string, message: unknown): void {
  process.stdout.write(`::${command}::${escapeData(message)}${EOL}`)
}

export function getInput(name: string, options: InputOptions = {}): string {
  const value =
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
  if (options.required && !value) {
    throw new Error(`Input required and not supplied: ${name}`)
  }
  return options.trimWhitespace === false ? value : value.trim()
}

export function debug(message: unknown): void {
  issueCommand('debug', message)
}

export function warning(message: string | Error): void {
  issueCommand(
    'warning',
    message instanceof Error ? message.toString() : message
  )
}

export function error(message: string | Error): void {
  issueCommand('error', message instanceof Error ? message.toString() : message)
}

export function info(message: string): void {
  process.stdout.write(`${message}${EOL}`)
}

export function setFailed(message: string | Error): void {
  process.exitCode = 1
  error(message)
}

export function startGroup(name: string): void {
  issueCommand('group', name)
}

export function endGroup(): void {
  issueCommand('endgroup', '')
}

export async function group<T>(
  name: string,
  action: () => Promise<T>
): Promise<T> {
  startGroup(name)
  try {
    return await action()
  } finally {
    endGroup()
  }
}
