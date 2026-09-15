;(globalThis as any).process ??= {
	env: {},
	browser: true,
	platform: 'browser',
	version: '',
	argv: [],
	cwd: () => '/',
	nextTick: (cb: (...a: any[]) => void, ...a: any[]) =>
		typeof queueMicrotask !== 'undefined' ? queueMicrotask(() => cb(...a)) : setTimeout(() => cb(...a), 0),
	on: () => {},
	once: () => {},
	off: () => {},
	addListener: () => {},
	removeListener: () => {},
	removeAllListeners: () => {},
	emit: () => {},
} as any
;(globalThis as any).global ??= globalThis
;(self as any).process ??= (globalThis as any).process
;(self as any).global ??= (globalThis as any).global
if (!(globalThis as any).process?.on) (globalThis as any).process.on = () => {}
if (typeof (globalThis as any).localStorage === 'undefined') {
	const _store = new Map<string, string>()
	;(globalThis as any).localStorage = {
		getItem: (k: string) => _store.get(k) ?? null,
		setItem: (k: string, v: string) => _store.set(k, String(v)),
		removeItem: (k: string) => _store.delete(k),
		clear: () => _store.clear(),
		key: (i: number) => Array.from(_store.keys())[i] ?? null,
		get length() {
			return _store.size
		},
	}
}
;(self as any).localStorage = (globalThis as any).localStorage
if (typeof (globalThis as any).assert !== 'function') {
	const assertFn: any = (value: unknown, message?: string) => {
		if (!value) throw new Error(message || 'Assertion failed')
	}
	assertFn.ok = assertFn
	assertFn.equal = (a: unknown, b: unknown, m?: string) => {
		// biome-ignore lint/suspicious/noDoubleEquals: assert.equal is loose equality by design, unlike strictEqual
		if (a != b) throw new Error(m || `${a} != ${b}`)
	}
	assertFn.strictEqual = (a: unknown, b: unknown, m?: string) => {
		if (a !== b) throw new Error(m || `${a} !== ${b}`)
	}
	;(globalThis as any).assert = assertFn
	;(self as any).assert = assertFn
}

let transpileInWorker: ((p: any) => Promise<string>) | undefined
const preload = import('./transpiler-worker-core.js')
	.then((mod: any) => {
		transpileInWorker = mod.transpileInWorker
	})
	.catch(() => {})

self.onmessage = async (e: MessageEvent) => {
	if (!transpileInWorker) await preload
	if (!transpileInWorker) {
		try {
			const mod: any = await import('./transpiler-worker-core.js')
			transpileInWorker = mod.transpileInWorker
		} catch (err: any) {
			;(self as any).postMessage({
				id: (e as any).data?.id,
				ok: false,
				error: (err?.message ?? String(err)) + (err?.stack ? '\n' + err.stack : ''),
			})
			return
		}
	}
	const { id, vbs, globalFunction, globalObject, tableData } = (e as any).data
	try {
		const js = await transpileInWorker!({ vbs, globalFunction, globalObject, tableData })
		;(self as any).postMessage({ id, ok: true, js })
	} catch (err: any) {
		;(self as any).postMessage({
			id,
			ok: false,
			error: (err?.message ?? String(err)) + (err?.stack ? '\n' + err.stack : ''),
		})
	}
}
