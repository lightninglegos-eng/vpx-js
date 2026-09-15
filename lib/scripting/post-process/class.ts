// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import { replace } from 'estraverse'
import type {
	BlockStatement,
	ClassBody,
	FunctionDeclaration,
	FunctionExpression,
	Identifier,
	MethodDefinition,
	Statement,
	VariableDeclaration,
} from 'estree'
import {
	assignmentExpression,
	blockStatement,
	classBody,
	classDeclaration,
	expressionStatement,
	functionExpression,
	identifier,
	memberExpression,
	methodDefinition,
	returnStatement,
	thisExpression,
	variableDeclaration,
	variableDeclarator,
} from '../estree.js'
import type { ESIToken } from '../grammar/grammar.js'

/** ppClass. */
export function ppClass(node: ESIToken): unknown {
	switch (node.type) {
		case 'ClassDeclaration':
			return ppClassDeclaration(node)
		case 'ConstructorMemberDeclaration':
			return ppConstructorMemberDeclaration(node)
		case 'RegularPropertyMemberDeclaration':
			return ppRegularPropertyMemberDeclaration(node)
		case 'PropertyGetDeclaration':
			return ppPropertyGetDeclaration(node)
		case 'PropertyLetDeclaration':
			return ppPropertyLetDeclaration(node)
		case 'PropertySetDeclaration':
			return ppPropertySetDeclaration(node)
	}
	return null
}

function ppClassDeclaration(node: ESIToken): unknown {
	let id = identifier('undefined')
	let constructor: MethodDefinition | undefined
	const methodDefinitions: MethodDefinition[] = []
	const varStmts: Statement[] = []
	const ids: string[] = []
	const methodNames: string[] = []
	for (const child of node.children) {
		switch (child.type) {
			case 'Identifier':
				id = child.estree
				break
			case 'ClassMemberDeclaration': {
				const memberDecl = child.children[0]
				switch (memberDecl.type) {
					case 'ConstructorMemberDeclaration':
						constructor = memberDecl.estree
						break
					case 'MethodMemberDeclaration': {
						const functionDecl = memberDecl.estree as FunctionDeclaration
						const functionId = functionDecl.id as Identifier
						methodNames.push(functionId.name)
						methodDefinitions.push(
							methodDefinition(
								functionId,
								'method',
								functionExpression(functionDecl.body, functionDecl.params),
							),
						)

						break
					}
					case 'PropertyMemberDeclaration':
						{
							const md = memberDecl.estree as MethodDefinition
							const key = (md.key as Identifier).name
							methodNames.push(key)
							methodDefinitions.push(md)
						}
						break
					case 'VariableMemberDeclaration':
					case 'ConstantMemberDeclaration':
						for (const varDecl of (memberDecl.estree as VariableDeclaration).declarations) {
							const varId = varDecl.id as Identifier
							varStmts.push(
								expressionStatement(
									assignmentExpression(
										memberExpression(thisExpression(), varId),
										'=',
										varDecl.init ? varDecl.init : identifier('undefined'),
									),
								),
							)
							ids.push(varId.name)
						}
						break
				}
				break
			}
		}
	}
	if (!constructor) {
		constructor = methodDefinition(
			identifier('constructor'),
			'constructor',
			functionExpression(blockStatement([]), []),
		)
	}
	let body: ClassBody = classBody([constructor, ...methodDefinitions])
	const idSet = new Set([...ids, ...methodNames].map(s => s.toLowerCase()))
	const methodLocals = new Map<string, Set<string>>()
	for (const m of body.body) {
		const md = m as MethodDefinition
		const key = (md.key as Identifier).name.toLowerCase()
		const fn = md.value as unknown as FunctionExpression
		const locals = new Set<string>()
		locals.add(key)
		for (const p of fn.params as Identifier[]) locals.add((p.name as string).toLowerCase())
		replace(fn.body as unknown as any, {
			enter: (n: any) => {
				if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
					locals.add((n.id.name as string).toLowerCase())
				}
			},
		})
		methodLocals.set(key, locals)
	}
	let currentMethod: string | undefined
	body = replace(body, {
		enter: (bodyNode: any, parentNode: any) => {
			if (bodyNode.type === 'MethodDefinition') {
				currentMethod = (bodyNode.key as Identifier).name.toLowerCase()
			}
			if (bodyNode.type === 'Identifier') {
				if (parentNode?.type === 'MethodDefinition') return
				if (parentNode?.type === 'VariableDeclarator' && parentNode.id === bodyNode) return
				if (parentNode?.type === 'FunctionExpression' && (parentNode.params as any[])?.includes(bodyNode))
					return
				if (currentMethod && methodLocals.get(currentMethod)?.has(bodyNode.name.toLowerCase())) return
				if (idSet.has(bodyNode.name.toLowerCase())) {
					if (parentNode?.type === 'MemberExpression') {
						if (parentNode.object?.type === 'Identifier') {
							if (parentNode.object.name.toLowerCase() === bodyNode.name.toLowerCase()) {
								return memberExpression(thisExpression(), identifier(bodyNode.name.toLowerCase()))
							}
						}
					} else {
						return memberExpression(thisExpression(), identifier(bodyNode.name.toLowerCase()))
					}
				}
			}
		},
		leave: (bodyNode: any) => {
			if (bodyNode.type === 'MethodDefinition') currentMethod = undefined
		},
	}) as ClassBody
	if ('value' in body.body[0]) {
		;(body.body[0] as unknown as { value: { body: { body: unknown[] } } }).value.body.body.unshift(...varStmts)
	}
	return classDeclaration(id, body)
}

function ppConstructorMemberDeclaration(node: ESIToken): unknown {
	let block: BlockStatement | undefined
	for (const child of node.children) {
		if (child.type === 'Block') {
			block = child.estree
		}
	}
	return methodDefinition(
		identifier('constructor'),
		'constructor',
		functionExpression(block ? block : blockStatement([]), []),
	)
}

function ppRegularPropertyMemberDeclaration(node: ESIToken): unknown {
	// The leading access modifier is optional in the grammar (matching Sub/Function), so its
	// presence shifts which child index holds the accessor declaration - find it by type
	// instead of assuming a fixed position, same approach ppConstructorMemberDeclaration uses.
	for (const child of node.children) {
		if (child.type === 'PropertyAccessorDeclaration') {
			return child.estree
		}
	}
	return null
}

function ppPropertyGetDeclaration(node: ESIToken): unknown {
	let id: Identifier = identifier('undefined')
	let params: Identifier[] = []
	let block: BlockStatement | undefined
	for (const child of node.children) {
		switch (child.type) {
			case 'Identifier':
				id = child.estree
				break
			case 'ParameterList':
				params = child.estree
				break
			case 'Block':
				block = child.estree
				break
		}
	}
	if (block) {
		block = replace(block, {
			enter: blockNode => {
				if (blockNode.type === 'ReturnStatement') {
					blockNode.argument = id
					return blockNode
				}
			},
		}) as BlockStatement
	} else {
		block = blockStatement([])
	}
	block.body.unshift(variableDeclaration('let', [variableDeclarator(id, identifier('undefined'))]))
	if (block.body[block.body.length - 1].type !== 'ReturnStatement') {
		block.body.push(returnStatement(id))
	}
	const kind = params.length === 0 ? ('get' as const) : ('method' as const)
	return methodDefinition(id, kind as any, functionExpression(block, params))
}

function ppPropertyLetDeclaration(node: ESIToken): unknown {
	let id: Identifier = identifier('undefined')
	let params: Identifier[] = []
	let block: BlockStatement | undefined
	for (const child of node.children) {
		switch (child.type) {
			case 'Identifier':
				id = child.estree
				break
			case 'ParameterList':
				params = child.estree
				break
			case 'Block':
				block = child.estree
				break
		}
	}
	const kind = params.length === 1 ? ('set' as const) : ('method' as const)
	return methodDefinition(id, kind as any, functionExpression(block ? block : blockStatement([]), params))
}

function ppPropertySetDeclaration(node: ESIToken): unknown {
	let id: Identifier = identifier('undefined')
	let params: Identifier[] = []
	let block: BlockStatement | undefined
	for (const child of node.children) {
		switch (child.type) {
			case 'Identifier':
				id = child.estree
				break
			case 'ParameterList':
				params = child.estree
				break
			case 'Block':
				block = child.estree
				break
		}
	}
	const kind = params.length === 1 ? ('set' as const) : ('method' as const)
	return methodDefinition(id, kind as any, functionExpression(block ? block : blockStatement([]), params))
}
