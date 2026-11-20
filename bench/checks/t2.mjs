// Hidden checks of task t2: parseCsv with quoted fields.
export default [
  ['plain CSV still works, and an empty text gives no rows', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('a,b\n1,2\n3,4\n'), [{ a: '1', b: '2' }, { a: '3', b: '4' }])
    assert.deepEqual(parseCsv(''), [])
  }],
  ['a quoted field can hold a comma', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('note,n\n"dinner, team",2\n'), [{ note: 'dinner, team', n: '2' }])
  }],
  ['two double quotes inside a quoted field stand for one', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('note,n\n"say ""hi"" twice",2\n'), [{ note: 'say "hi" twice', n: '2' }])
    assert.deepEqual(parseCsv('note\n""""\n'), [{ note: '"' }])
  }],
  ['lines can end with \\r\\n', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n3,"x, y"\r\n'), [{ a: '1', b: '2' }, { a: '3', b: 'x, y' }])
  }],
  ['a cell without quotes is trimmed, and a quoted cell keeps its spaces', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('a,b\n  x  ,"  y  "\n'), [{ a: 'x', b: '  y  ' }])
  }],
  ['the names in the header follow the same rules', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv(' first ,"last, name"\n1,2\n'), [{ first: '1', 'last, name': '2' }])
  }],
  ['a line with fewer cells than the header gives empty text', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('a,b,c\n1\n4,5\n'), [{ a: '1', b: '', c: '' }, { a: '4', b: '5', c: '' }])
  }],
  ['empty lines between rows and at the end are skipped', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('a,b\n\n1,2\n\n\n3,4\n\n'), [{ a: '1', b: '2' }, { a: '3', b: '4' }])
    assert.deepEqual(parseCsv('a,b\r\n\r\n1,2\r\n\r\n'), [{ a: '1', b: '2' }])
  }],
  ['a line break inside a quoted field is kept', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.deepEqual(parseCsv('note,n\n"line one\nline two",2\n3,4\n'), [{ note: 'line one\nline two', n: '2' }, { note: '3', n: '4' }])
    assert.deepEqual(parseCsv('note,n\n"one\n\ntwo",2\n'), [{ note: 'one\n\ntwo', n: '2' }])
  }],
  ['a quote that is never closed is a SyntaxError', async ({ load, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    assert.throws(() => parseCsv('a,b\n"open,2\n'), SyntaxError)
    assert.throws(() => parseCsv('a,b\n1,"never closed'), SyntaxError)
  }],
]
