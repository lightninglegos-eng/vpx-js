import * as fs from 'node:fs'
import { Grammar } from './dist-esm/lib/scripting/grammar/grammar.js'
import { normalizeNewCall } from './dist-esm/lib/scripting/transpiler.js'

const file = process.argv[2]
const vbs = fs.readFileSync(file, 'utf-8')
const grammar = new Grammar()
try {
	grammar.transpile(normalizeNewCall(vbs))
	console.log('OK')
} catch (e) {
	console.log('FAIL:', (e.message || String(e)).split('\n').slice(0, 2).join(' | '))
}
