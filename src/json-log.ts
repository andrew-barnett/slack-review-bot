// One JSON object per line on stdout: the log format of the container entrypoints and the host
// launcher (docker logs and launchd capture stdout). Event names are constants; variable data goes in
// the fields object.

export function jsonLog(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}
