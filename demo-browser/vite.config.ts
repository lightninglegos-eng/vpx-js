import fs from 'node:fs'
import os from 'node:os'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname)
const repoRoot = resolve(__dirname, '..')
const home = process.env.HOME || os.homedir() || '/home/qinghao1'

function rawLoader() {
	return {
		name: 'raw-loader',
		enforce: 'pre' as const,
		resolveId(source: string, importer: string | undefined) {
			const clean = source.split('?')[0].split('#')[0]
			if (!(clean.endsWith('.vbs') || clean.endsWith('.bnf'))) return null
			const tryPaths: string[] = []
			if (clean.startsWith('.') && importer) {
				try {
					let base = importer.split('?')[0].split('#')[0]
					if (base.startsWith('/@fs')) base = base.slice(4)
					tryPaths.push(resolve(path.dirname(base), clean))
				} catch {}
			}
			try {
				const p = clean.startsWith('/@fs') ? clean.slice(4) : clean
				if (path.isAbsolute(p)) tryPaths.push(p)
			} catch {}
			if (clean.includes('res/scripts') || clean.includes('grammar')) {
				const baseName = path.basename(clean)
				if (clean.endsWith('.vbs')) tryPaths.push(resolve(repoRoot, 'res/scripts', baseName))
				if (clean.endsWith('.bnf')) tryPaths.push(resolve(repoRoot, 'lib/scripting/grammar', baseName))
				tryPaths.push(resolve(repoRoot, clean.replace(/^(\.\.\/)+/, '')))
			}
			for (const p of tryPaths)
				try {
					if (fs.existsSync(p)) return p
				} catch {}
			return null
		},
		load(id: string) {
			const clean = id.split('?')[0].split('#')[0]
			if (clean.endsWith('.vbs') || clean.endsWith('.bnf')) {
				try {
					let p = clean
					if (p.startsWith('/@fs')) p = p.slice(4)
					return `export default ${JSON.stringify(fs.readFileSync(p, 'utf-8'))};`
				} catch {}
			}
		},
	}
}

const define = {
	'process.env': '(globalThis.process?.env ?? {})',
	process: '(globalThis.process ?? {env:{},browser:true,platform:"browser"})',
	global: 'globalThis',
}

export default defineConfig({
	define,
	optimizeDeps: {
		include: ['three', 'three/webgpu', 'three/tsl', 'three-mesh-bvh', 'wpc-emu'],
	},
	root,
	base: './',
	resolve: {
		dedupe: ['three', 'three/webgpu', 'three/tsl', 'three-mesh-bvh'],
		alias: [
			{ find: 'node:buffer', replacement: resolve(__dirname, 'node_modules/buffer/index.js') },
			{
				find: /^node:assert(\/strict)?$/,
				replacement: resolve(__dirname, 'node_modules/assert/build/assert.js'),
			},
			{ find: /^assert(\/strict)?$/, replacement: resolve(__dirname, 'node_modules/assert/build/assert.js') },
			{ find: 'buffer', replacement: resolve(__dirname, 'node_modules/buffer/index.js') },
			{ find: 'three-mesh-bvh', replacement: resolve(__dirname, 'node_modules/three-mesh-bvh/src/index.js') },
			{ find: /^refs\.node\.js$/, replacement: resolve(repoRoot, 'dist-esm/lib/refs.browser.js') },
			{ find: /^.*refs\.node\.js(\?.*)?$/, replacement: resolve(repoRoot, 'dist-esm/lib/refs.browser.js') },
			{
				find: /^.*vbs-scripts\.node\.js(\?.*)?$/,
				replacement: resolve(repoRoot, 'dist-esm/lib/scripting/vbs-scripts.browser.js'),
			},
			{
				find: /^.*binary-reader\.node\.js(\?.*)?$/,
				replacement: resolve(repoRoot, 'dist-esm/lib/io/binary-reader.js'),
			},
			{
				find: /^.*three-texture-loader-node\.js(\?.*)?$/,
				replacement: resolve(repoRoot, 'dist-esm/lib/render/threejs/three-texture-loader-browser.js'),
			},
		],
	},
	assetsInclude: ['**/*.vpx', '**/*.wasm', '**/*.zip'],
	publicDir: resolve(__dirname, 'public'),
	server: {
		hmr: { overlay: false },
		port: 3000,
		host: true,
		watch: { ignored: ['**/dist/**', '**/dist-esm/**', '**/node_modules/**', '**/.git/**'] },
		fs: {
			allow: [
				root,
				repoRoot,
				resolve(repoRoot, 'dist'),
				resolve(repoRoot, 'dist-esm'),
				resolve(repoRoot, 'wasm/dist'),
				resolve(repoRoot, 'wasm/kernels/dist'),
				resolve(repoRoot, 'test/fixtures'),
				resolve(home, 'Downloads'),
				resolve(home, '.pinmame/roms'),
			],
			strict: false,
		},
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'cross-origin',
		},
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'cross-origin',
		},
	},
	plugins: [
		rawLoader(),
		{
			name: 'static-fs',
			configureServer(server) {
				const send = (res: any, req: any, file: string, type: string) => {
					res.setHeader('Content-Type', type)
					res.setHeader('Content-Length', String(fs.statSync(file).size))
					res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
					res.setHeader('Access-Control-Allow-Origin', '*')
					if (req.method === 'HEAD') {
						res.end()
						return true
					}
					fs.createReadStream(file).pipe(res)
					return true
				}
				server.middlewares.use((req: any, res: any, next: any) => {
					const url = req.url?.split('?')[0].split('#')[0] ?? ''
					if (url.startsWith('/wasm/')) {
						const rel = url.slice('/wasm/'.length)
						const tries = [
							resolve(repoRoot, `wasm/${rel}`),
							resolve(repoRoot, `wasm/kernels/dist/${rel}`),
							resolve(repoRoot, `wasm/dist/${rel}`),
							resolve(repoRoot, `wasm/mock/${rel}`),
						]
						if (rel === 'kernels.js' || rel === 'kernels.wasm')
							tries.unshift(resolve(repoRoot, `wasm/kernels/dist/${rel}`))
						for (const f of tries)
							if (fs.existsSync(f)) {
								try {
									const ext = path.extname(f).toLowerCase()
									const ct =
										ext === '.wasm'
											? 'application/wasm'
											: ext === '.js'
												? 'application/javascript'
												: 'application/octet-stream'
									res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
									res.setHeader('Cache-Control', 'no-cache')
									if (send(res, req, f, ct)) return
								} catch {}
							}
					}
					if (url.startsWith('/test/fixtures/') && url.endsWith('.vpx')) {
						req.url = '/@fs' + resolve(repoRoot, url.slice(1))
						return next()
					}
					if (url.endsWith('.zip') && (url.includes('/roms/') || url.includes('/pinmame/'))) {
						const base = path.basename(url)
						const homeCandidates = [
							resolve(home, 'Downloads', base),
							resolve(home, '.pinmame/roms', base),
							resolve(home, 'pinmame/roms', base),
						]
						for (const c of [
							resolve(__dirname, 'public', url.slice(1)),
							resolve(__dirname, `public/pinmame/roms/${base}`),
							resolve(__dirname, `public/roms/${base}`),
							...homeCandidates,
						]) {
							if (fs.existsSync(c))
								try {
									if (send(res, req, c, 'application/zip')) return
								} catch {}
						}
						for (const c of homeCandidates) {
							const lower = c.toLowerCase()
							if (lower !== c && fs.existsSync(lower))
								try {
									if (send(res, req, lower, 'application/zip')) return
								} catch {}
						}
					}
					next()
				})
			},
		},
	],
	worker: { format: 'es' },
	build: { target: 'esnext', assetsInlineLimit: 0 },
})
