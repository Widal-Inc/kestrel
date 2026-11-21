// Sends benchmark records to the Widal.Code board that this computer is linked to.
//
// Only bench/export.mjs --send calls this: nothing sends a record without that command. The
// records go to the address the person linked with "widal board login", with that link's token,
// and to no other address: a move to another address is not followed. bench/record.mjs says what
// a record holds. The board pools the records of all teams per task and setting, without the
// name of a team or a computer.
import { gzipSync } from 'node:zlib'
import { version } from '../src/app.mjs'

/** How many records one request holds. The board takes up to 5,000. */
const PER_REQUEST = 2000
const REQUEST_MS = 60e3

/**
 * @param {object[]} records As publicRecord() of bench/record.mjs gives them.
 * @param {{ url: string, token: string } | undefined} board The link to send to, as readBoard()
 *   of src/board.mjs gives it. It must be given: this function never looks the link up itself, so
 *   that a test cannot send to the person's own board by leaving it out.
 * @returns {Promise<{ ok: boolean, sent: number, text: string }>} `text` says what happened, in
 *   plain words, for the person.
 */
export async function sendRecords(records, board, { timeout = REQUEST_MS } = {}) {
  if (!board) return { ok: false, sent: 0, text: 'This computer is not linked to a Widal.Code board, so nothing was sent. Link it with: widal board login <address>' }
  let sent = 0
  const some = () => (sent ? ` ${sent} records were stored before that.` : '')
  for (let i = 0; i < records.length; i += PER_REQUEST) {
    const part = records.slice(i, i + PER_REQUEST)
    let res
    try {
      res = await fetch(`${board.url}/api/v1/bench`, {
        method: 'POST',
        // The board reads the user agent kestrel/<version>, as for everything else Widal.Code sends.
        headers: { accept: 'application/json', 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${board.token}`, 'user-agent': `kestrel/${version() ?? 'unknown'}` },
        body: gzipSync(JSON.stringify({ v: 1, records: part })),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? `no answer within ${Math.round(timeout / 1000)} seconds` : 'no connection'
      return { ok: false, sent, text: `Could not reach the board at ${board.url} (${why}).${some()}` }
    }
    if (res.status !== 200) {
      let said
      try {
        said = (await res.json())?.error
      } catch {
        // The answer is not JSON.
      }
      said = typeof said === 'string' ? said.replace(/[^\x20-\x7e]/g, ' ').slice(0, 300) : undefined
      const why =
        res.status === 404 || res.status === 405
          ? 'This board does not take benchmark records: it runs a version from before that was added.'
          : res.status === 401 || res.status === 403
            ? 'The board does not take this computer\'s token. Link the computer again with: widal board login <address>'
            : res.status >= 300 && res.status < 400
              ? 'The board answered with a move to another address, which is not followed. Link again with the right address: widal board login <address>'
              : `The board answered ${res.status}${said ? `: ${said}` : ''}.`
      return { ok: false, sent, text: `${why} The records of this request were not stored.${some()}` }
    }
    sent += part.length
  }
  return { ok: true, sent, text: `The board at ${board.url} has the ${sent} records. A record it had already was not stored again.` }
}
