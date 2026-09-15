import type { Program } from 'estree'
import { Enums } from '../vpt/enums.js'
import { GlobalApi } from '../vpt/global-api.js'
import { Grammar } from './grammar/grammar.js'
import { Stdlib } from './stdlib/index.js'
import { AmbiguityTransformer } from './transformer/ambiguity-transformer.js'
import { ClassTransformer } from './transformer/class-transformer.js'
import { ErrorTransformer } from './transformer/error-transformer.js'
import { EventTransformer } from './transformer/event-transformer.js'
import { FunctionHoistTransformer } from './transformer/function-hoist-transformer.js'
import { ReferenceTransformer } from './transformer/reference-transformer.js'
import { ScopeTransformer } from './transformer/scope-transformer.js'
import { WrapTransformer } from './transformer/wrap-transformer.js'

/** Splits a statement list on top-level colons, ignoring colons inside double-quoted strings. */
function splitOnColons(s: string): string[] {
	const parts: string[] = []
	let cur = ''
	let inStr = false
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (c === '"') {
			inStr = !inStr
			cur += c
		} else if (c === ':' && !inStr) {
			parts.push(cur)
			cur = ''
		} else {
			cur += c
		}
	}
	parts.push(cur)
	return parts.map(p => p.trim()).filter(Boolean)
}

/** Finds the first top-level (outside quotes) standalone "Else" keyword, or null if none. */
function splitTopLevelElse(s: string): [string, string] | null {
	let inStr = false
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (c === '"') {
			inStr = !inStr
			continue
		}
		if (inStr) continue
		if (/else/i.test(s.slice(i, i + 4))) {
			const before = i === 0 || /\W/.test(s[i - 1] as string)
			const after = i + 4 >= s.length || /\W/.test(s[i + 4] as string)
			if (before && after) return [s.slice(0, i), s.slice(i + 4)]
		}
	}
	return null
}

function normalizeNewCall(vbs: string): string {
	let out = vbs.replace(/Set\s+(\w+)\s*=\s*\(\s*New\s+(\w+)\s*\)\s*\(([^)]*)\)/gi, (_, v, c, a) => {
		const args = (a as string).trim()
		return args ? `Set ${v} = New ${c}\n${v}.init ${args}` : `Set ${v} = New ${c}`
	})
	out = out.replace(/\(\s*New\s+(\w+)\s*\)\s*\(/gi, '(New $1).init(')
	out = out.replace(/\.Option\b/gi, '._Option')
	out = out.replace(/(?<!\.)\bswitch\b/gi, 'aSwitch')
	// C-style (int)(expr) cast idiom some tables use in place of Int(expr)
	out = out.replace(/\(\s*int\s*\)\s*\(/gi, 'Int(')
	// single-line block "If cond Then stmt [Else stmt] : End If" - the colon before
	// End If plays the role of a newline here, so "Then"/"Else" need their own line too,
	// or the grammar reads the rest of the line as one (invalid) statement. Must run
	// before the "Then:" fix below, which would otherwise eat the colon this needs to
	// tell an empty-bodied "Then:End If" apart from an ordinary "Then:stmt".
	out = out.replace(/\bThen\s+(.+?)\s*:\s*(End\s+If)\b/gi, (_m, body: string, endIf: string) => {
		const parts = splitTopLevelElse(body)
		if (parts) {
			const [thenBody, elseBody] = parts
			return `Then\n${splitOnColons(thenBody).join('\n')}\nElse\n${splitOnColons(elseBody).join('\n')}\n${endIf}`
		}
		return `Then\n${splitOnColons(body).join('\n')}\n${endIf}`
	})
	// single-line Sub/Function/Property declaration ("Name(args) : body : End X") - the
	// grammar's Class-body rule can fail to parse a mix of these and ordinary multi-line
	// members in the same class, so normalize every one to multi-line form. Runs before
	// the hoist pass below so a colon-form Sub nested in a conditional also gets hoisted.
	out = out.replace(
		/^([ \t]*)((?:Public\s+|Private\s+)?(?:Property\s+(?:Get|Let|Set)|Sub|Function)\s+\w+(?:\s*\([^)]*\))?)\s*:(?:\s*(.+?)\s*:)?\s*(End\s+(?:Sub|Function|Property))[ \t]*$/gim,
		(_m, indent: string, decl: string, body: string | undefined, end: string) => {
			if (!body) return `${indent}${decl}\n${indent}${end}`
			const stmts = splitOnColons(body)
			return `${indent}${decl}\n${stmts.map(s => indent + '\t' + s).join('\n')}\n${indent}${end}`
		},
	)
	// single-line "If cond Then:stmt" - the colon is a legal (if unusual) empty
	// statement separator in real VBScript, but this grammar requires "Then stmt"
	out = out.replace(/\bThen\s*:/gi, 'Then ')
	// Sub/Function bodies are declarations, never executed in place, so real VBScript
	// hoists them regardless of lexical nesting (e.g. inside an If block) - this grammar
	// only accepts them at the top level, so move every one there unconditionally.
	const subs: string[] = []
	out = out.replace(/^[ \t]*(?:Public\s+|Private\s+)?(Sub|Function)\s+\w+[\s\S]*?^[ \t]*End\s+\1[ \t]*$/gim, m => {
		subs.push(m)
		return ''
	})
	if (subs.length) out += '\n' + subs.join('\n') + '\n'
	return out
}

export interface TableDataPayload {
	elementNames: string[]
	elementEvents: Record<string, string[]>
	elementApis: Record<string, string[]>
	elementApiFuncs?: Record<string, string[]>
	elementApiUndefined?: Record<string, string[]>
	globalFuncs?: string[]
	globalUndefined?: string[]
}

export async function transpileInWorker(payload: {
	vbs: string
	globalFunction?: string
	globalObject?: string
	tableData?: TableDataPayload | null
}): Promise<string> {
	const escodegenModule: any = await import('escodegen')
	const generate =
		escodegenModule.generate ?? escodegenModule.default?.generate ?? escodegenModule.default?.default?.generate
	const { vbs, globalFunction, globalObject, tableData } = payload
	const grammar = new Grammar()
	let ast: Program = grammar.transpile(normalizeNewCall(vbs))
	let tableMock: any = null
	const itemApis: Record<string, unknown> = {}
	const stdlibMock: any = new Stdlib()
	let globalMock: any = null
	if (tableData) {
		const lowerMap = new Map<string, string>()
		for (const n of tableData.elementNames) lowerMap.set(n.toLowerCase(), n)
		tableMock = {
			getElementApiName: (n: string) => lowerMap.get(n.toLowerCase()),
			getElements: () => {
				const els: Record<string, any> = {}
				for (const n of tableData.elementNames)
					els[n] = { getName: () => n, getEventNames: () => tableData.elementEvents?.[n] ?? [] }
				return els
			},
		}
		const funcs = tableData.elementApiFuncs ?? {}
		const undef = tableData.elementApiUndefined ?? {}
		for (const [name, props] of Object.entries(tableData.elementApis)) {
			const map = new Map<string, string>()
			const mock: any = {}
			const f = new Set((funcs[name] ?? []).map(s => s.toLowerCase()))
			const u = new Set((undef[name] ?? []).map(s => s.toLowerCase()))
			for (const p of props) {
				map.set(p.toLowerCase(), p)
				mock[p] = f.has(p.toLowerCase()) ? () => {} : u.has(p.toLowerCase()) ? undefined : 0
			}
			mock._getPropertyName = (n: string) => map.get(n.toLowerCase())
			itemApis[name] = mock
		}
		const gf = new Set((tableData.globalFuncs ?? []).map(s => s.toLowerCase()))
		const gu = new Set((tableData.globalUndefined ?? []).map(s => s.toLowerCase()))
		const gMap = new Map<string, string>()
		const gMock: any = {}
		for (const p of Object.getOwnPropertyNames(GlobalApi.prototype)) {
			gMap.set(p.toLowerCase(), p)
			gMock[p] = gf.has(p.toLowerCase()) ? () => {} : gu.has(p.toLowerCase()) ? undefined : 0
		}
		gMock._getPropertyName = (n: string) => gMap.get(n.toLowerCase())
		globalMock = gMock
	} else {
		tableMock = { getElementApiName: () => undefined, getElements: () => ({}) }
		globalMock = {
			_getPropertyName: (n: string) => {
				for (const k of Object.getOwnPropertyNames(GlobalApi.prototype))
					if (k.toLowerCase() === n.toLowerCase()) return k
				return undefined
			},
		}
	}
	const pipeline = [
		(a: Program) => new FunctionHoistTransformer(a).transform(),
		(a: Program) => new EventTransformer(a, tableMock.getElements()).transform(),
		(a: Program) => new ErrorTransformer(a).transform(),
		(a: Program) =>
			new ReferenceTransformer(a, tableMock, itemApis, Enums as any, globalMock, stdlibMock).transform(),
		(a: Program) => new ScopeTransformer(a).transform(),
		(a: Program) => new ClassTransformer(a).transformThisIdentifiers(),
		(a: Program) => new AmbiguityTransformer(a, itemApis, Enums as any, globalMock, stdlibMock).transform(),
		(a: Program) => new ClassTransformer(a).transform(),
		(a: Program) => new WrapTransformer(a).transform(globalFunction, globalObject),
	]
	for (const fn of pipeline) ast = fn(ast)
	return generate(ast)
}
