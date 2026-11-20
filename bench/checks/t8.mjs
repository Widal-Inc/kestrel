// Hidden checks of task t8: the section "Commands" of the README.

/** The sections of a Markdown text, keyed by their "## " heading. The text before the first one is under "". */
function sections(text) {
  const out = new Map([['', []]])
  let name = ''
  for (const line of text.split('\n')) {
    const heading = /^## +(.*?)\s*$/.exec(line)
    if (heading) {
      name = heading[1]
      out.set(name, [])
    } else out.get(name).push(line)
  }
  return new Map([...out].map(([key, lines]) => [key, lines.join('\n').trim()]))
}

/** The bullet of one command in the section "Commands", or undefined. */
function bullet(text, command) {
  const lines = (sections(text).get('Commands') ?? '').split('\n')
  return lines.find((line) => new RegExp('^\\s*[-*]\\s+`ledger ' + command + '\\b').test(line))
}

export default [
  ['the README still has a section "Commands"', ({ read, assert }) => {
    assert.ok(sections(read('README.md')).has('Commands'))
  }],
  ['"report" is listed with --by, --from and --to', ({ read, assert }) => {
    const line = bullet(read('README.md'), 'report')
    assert.ok(line, 'no bullet for "ledger report"')
    for (const flag of ['--by', '--from', '--to', 'month']) assert.ok(line.includes(flag), `the bullet does not show ${flag}`)
  }],
  ['"list" is listed with --page and --size', ({ read, assert }) => {
    const line = bullet(read('README.md'), 'list')
    assert.ok(line, 'no bullet for "ledger list"')
    for (const flag of ['--page', '--size']) assert.ok(line.includes(flag), `the bullet does not show ${flag}`)
  }],
  ['"check" and "help" are listed', ({ read, assert }) => {
    assert.ok(bullet(read('README.md'), 'check'), 'no bullet for "ledger check"')
    assert.ok(bullet(read('README.md'), 'help'), 'no bullet for "ledger help"')
  }],
  ['"export", which does not exist, is not listed', ({ read, assert }) => {
    assert.equal(bullet(read('README.md'), 'export'), undefined)
    assert.ok(!/ledger export/.test(sections(read('README.md')).get('Commands') ?? ''))
  }],
  ['the other sections are not changed', ({ read, readStart, assert }) => {
    const now = sections(read('README.md'))
    const before = sections(readStart('README.md'))
    assert.deepEqual([...now.keys()], [...before.keys()])
    for (const [name, text] of before) if (name !== 'Commands') assert.equal(now.get(name), text, `the section "${name || 'top'}" changed`)
  }],
  ['no other file is changed', ({ changed, assert }) => {
    assert.deepEqual(changed.filter((file) => file !== 'README.md'), [])
  }],
]
