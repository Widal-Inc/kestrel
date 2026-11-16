// This tool's own settings (config.json in its folder), and how its small state files are read
// and written. The status line, the hooks and the billing check all use these.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './paths.mjs'

/** A JSON file as a value. `fallback` when the file is missing or cannot be read. */
export const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Writes a JSON file through a temp file and a rename, so that no reader ever sees half a file. */
export const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, file)
}

/** The file that holds this tool's settings. */
export const configFile = () => join(home(), 'config.json')

export const config = () => readJson(configFile(), {})
export const saveConfig = (c) => {
  mkdirSync(home(), { recursive: true })
  writeJson(configFile(), c)
}
