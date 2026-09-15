import { generate } from 'escodegen'
import type { Program } from 'estree'
import type { Player } from '../game/player.js'
import { type AnimationGate, animationGate } from '../util/animation-gate.js'
import { Enums, type EnumsApi } from '../vpt/enums.js'
import { GlobalApi } from '../vpt/global-api.js'
import type { Table } from '../vpt/table/table.js'
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
import { VBSHelper } from './vbs-helper.js'
import { VbsProxyHandler } from './vbs-proxy-handler.js'

declare function play(
	scope: unknown,
	table: Record<string, unknown>,
	enums: EnumsApi,
	globalApi: GlobalApi,
	stdlib: Stdlib,
	vbsHelper: VBSHelper,
	player: Player,
): void

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

export function normalizeNewCall(vbs: string): string {
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

export class Transpiler {
	private readonly itemApis: Record<string, unknown>
	private readonly enumApis: EnumsApi = Enums
	private readonly globalApi: GlobalApi
	private readonly stdlib = new Stdlib()
	private readonly grammar = new Grammar()

	constructor(
		private readonly table: Table,
		private readonly player: Player,
		private readonly gate: AnimationGate = player.gate ?? animationGate,
	) {
		this.itemApis = table.getElementApis()
		this.globalApi = new GlobalApi(table, player)
	}

	private pipeline(gf?: string, go?: string): Array<(ast: Program) => Program> {
		return [
			a => new FunctionHoistTransformer(a).transform(),
			a => new EventTransformer(a, this.table.getElements()).transform(),
			a => new ErrorTransformer(a).transform(),
			a =>
				new ReferenceTransformer(
					a,
					this.table,
					this.itemApis,
					this.enumApis,
					this.globalApi,
					this.stdlib,
				).transform(),
			a => new ScopeTransformer(a).transform(),
			a => new ClassTransformer(a).transformThisIdentifiers(),
			a => new AmbiguityTransformer(a, this.itemApis, this.enumApis, this.globalApi, this.stdlib).transform(),
			a => new ClassTransformer(a).transform(),
			a => new WrapTransformer(a).transform(gf, go),
		]
	}

	private parseAndTransform(vbs: string, gf?: string, go?: string): { ast: Program; t0: number } {
		const src = normalizeNewCall(vbs)
		const t0 = Date.now()
		let ast = this.grammar.transpile(src)
		ast = this.pipeline(gf, go).reduce((a, fn) => fn(a), ast)
		return { ast, t0 }
	}

	private gen(ast: Program, t0: number): string {
		return generate(ast)
	}

	private evalAndPlay(js: string, scope: Record<string, unknown>): void {
		eval(`//@ sourceURL=game:///tablescript.vbs.js\n${js}`)
		const playFn = (globalThis as any).play ?? (typeof play === 'function' ? play : undefined)
		if (typeof playFn === 'function') {
			playFn(
				new Proxy(scope, new VbsProxyHandler()),
				this.itemApis,
				this.enumApis,
				this.globalApi,
				this.stdlib,
				new VBSHelper(this),
				this.player,
			)
		}
	}

	public transpile(vbs: string, gf?: string, go?: string): string {
		const { ast, t0 } = this.parseAndTransform(vbs, gf, go)
		return this.gen(ast, t0)
	}

	public async transpileAsync(vbs: string, gf?: string, go?: string): Promise<string> {
		const { transpileWithWorker, getTableDataForWorker } = await import('./transpiler-worker-pool.js')
		const td = getTableDataForWorker(this.table, this.player)
		return transpileWithWorker(vbs, gf, go, td)
	}

	public execute(vbs: string, scope: Record<string, unknown>, go?: string): void {
		go ||= 'globalThis'
		this.evalAndPlay(this.transpile(vbs, 'play', go), scope)
	}

	public async executeAsync(vbs: string, scope: Record<string, unknown>, go?: string): Promise<void> {
		go ||= 'globalThis'
		this.evalAndPlay(await this.transpileAsync(vbs, 'play', go), scope)
	}
}
