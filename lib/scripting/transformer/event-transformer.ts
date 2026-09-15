// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import { replace, traverse } from 'estraverse'
import type { FunctionDeclaration, Program } from 'estree'
import type { IScriptable } from '../../game/iscriptable.js'
import {
	callExpression,
	expressionStatement,
	functionExpression,
	identifier,
	literal,
	memberExpression,
} from '../estree.js'
import { Transformer } from './transformer.js'

/**
 * This transforms event subs into proper JavaScript event listeners.
 *
 * Example: `function Plunger_Init() {}` would become: `Plunger.on('Init', () => {})`.
 */
export class EventTransformer extends Transformer {
	private readonly itemMap: Map<string, { key: string; item: IScriptable<any> }>

	constructor(ast: Program, items: { [p: string]: IScriptable<any> }) {
		super(ast)
		this.itemMap = new Map()
		for (const [k, v] of Object.entries(items)) this.itemMap.set(k.toLowerCase(), { key: k, item: v })
	}

	public transform(): Program {
		// VBScript identifiers are case-insensitive, so two Subs that only differ by case
		// (e.g. leftover "ghost" duplicates like `Sub Kicker1_Hit` and `Sub kicker1_hit()`)
		// name the same procedure in real VBScript - only one definition can be live, with
		// the last one in the script winning. JS function names are case-sensitive though, so
		// both survive as distinct FunctionDeclarations here; without this pre-pass each would
		// get wired to its own `.on()` listener and BOTH bodies would fire on every event,
		// instead of just the last-declared one - silently doubling up side effects (e.g. a
		// kicker feeding an extra ball into play on every hit).
		const winnerByKey = new Map<string, FunctionDeclaration>()
		traverse(this.ast, {
			enter: node => {
				const match = this.matchEventSub(node)
				if (!match) return
				const key = `${match.entry.key.toLowerCase()}::${match.eventName.toLowerCase()}`
				winnerByKey.set(key, match.functionNode)
			},
		})

		return replace(this.ast, {
			enter: (node, _parent: any) => {
				const match = this.matchEventSub(node)
				if (!match) return node

				const key = `${match.entry.key.toLowerCase()}::${match.eventName.toLowerCase()}`
				if (winnerByKey.get(key) !== match.functionNode) {
					// shadowed duplicate - leave it as an ordinary, unwired function declaration
					return node
				}

				return expressionStatement(
					callExpression(memberExpression(identifier(match.entry.key), identifier('on')), [
						literal(match.eventName),
						functionExpression(match.functionNode.body, match.functionNode.params),
					]),
				)
			},
		}) as Program
	}

	private matchEventSub(
		node: any,
	):
		| { functionNode: FunctionDeclaration; entry: { key: string; item: IScriptable<any> }; eventName: string }
		| undefined {
		// must be a function
		if (node.type !== 'FunctionDeclaration') return undefined
		const functionNode = node as FunctionDeclaration

		// must have an id (duh.)
		if (!functionNode.id) return undefined

		// must have a _Event suffix
		if (!functionNode.id.name.includes('_')) return undefined

		// split on last index
		const objName = functionNode.id.name.substr(0, functionNode.id.name.lastIndexOf('_'))
		const eventName = functionNode.id.name.substr(functionNode.id.name.lastIndexOf('_') + 1)

		const entry = this.itemMap.get(objName.toLowerCase())
		if (!entry) return undefined

		const existingEventName = matchEventName(entry.item.getEventNames(), eventName)
		if (!existingEventName) return undefined

		return { functionNode, entry, eventName: existingEventName }
	}
}

function matchEventName(eventNames: string[], nameToMatch: string): string | undefined {
	for (const eventName of eventNames) {
		if (eventName.toLowerCase() === nameToMatch.toLowerCase()) {
			return eventName
		}
	}
}
