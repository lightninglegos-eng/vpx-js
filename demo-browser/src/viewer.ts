// @ts-nocheck
// Viewer coordinator - delegates to subsystems

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as THREE from 'three/webgpu'
import { keyEventToDirectInputKey } from '../../dist-esm/lib/game/key-code.js'
import { Player } from '../../dist-esm/lib/game/player.js'
import {
	BALL_STRIDE,
	createPhysicsSAB,
	MAX_BALLS,
	pushInput,
	trySnap,
} from '../../dist-esm/lib/game/shared/physics-buffer.js'
import { BrowserBinaryReader } from '../../dist-esm/lib/io/binary-reader.js'
import { isWasmReady } from '../../dist-esm/lib/physics/wasm/kernels.js'
import { setGlobalEmissionScale } from '../../dist-esm/lib/render/threejs/material-shared.js'
import {
	batchStaticOpaques as _batchStaticOpaques,
	optimizeScene as _optimizeScene,
} from '../../dist-esm/lib/render/threejs/three-batched-builder.js'
import { buildBvhIdle } from '../../dist-esm/lib/render/threejs/three-bvh.js'
import {
	applyCameraState,
	computePlayFraming,
	computeViewerFraming,
	frameCamera,
} from '../../dist-esm/lib/render/threejs/three-camera-framing.js'
import { ThreeRenderApi } from '../../dist-esm/lib/render/threejs/three-render-api.js'
import { VpxRenderPipeline } from '../../dist-esm/lib/render/threejs/three-render-pipeline.js'
import {
	applyBakedMaterial,
	ensureProceduralRoom,
	hideCabFlippers,
	isBakedMeshByNames,
	isDeferred,
	postProcessScene,
	showCabFlippers,
} from '../../dist-esm/lib/render/threejs/three-scene-postprocess.js'
import { ThreeTextureLoaderBrowser } from '../../dist-esm/lib/render/threejs/three-texture-loader-browser.js'
import {
	applyRendererToneMapping,
	clampExposure,
	resolveToneMapping,
} from '../../dist-esm/lib/render/threejs/tone-mapping.js'
import { AnimationGate } from '../../dist-esm/lib/util/animation-gate.js'
import { Table } from '../../dist-esm/lib/vpt/table/table.js'
import { CAM, CAM_ANIM, isTableHit, LIGHT_AMBIENT, LIGHT_DIR, LIGHT_HEMI, RE_BAKE_MAP, TABLE_OPTS } from './config.js'
import { DmdRenderer } from './dmd/dmd-renderer.js'
import {
	isDev as _isDev,
	ensureBvh,
	ensureGlobals,
	getMaxLights,
	getTargetPixelRatio,
	isLowQuality,
	QUALITY_CAPS,
} from './env.js'
import { attachInput } from './input.js'
import { createHarness } from './log-overlay.js'
import { renderModeHint, renderStats } from './stats-panel.js'
import {
	$,
	computeTexMem,
	countObjects,
	fetchWithProgress,
	filterTextures,
	fmtBytes,
	logMem,
	resolveRomCandidates,
	resolveVpxCandidates,
} from './utils.js'

let _prerenderedBackground: THREE.Color | null = null
function getPrerenderedBackground(): THREE.Color {
	if (_prerenderedBackground) return _prerenderedBackground
	_prerenderedBackground = new THREE.Color(0x121a2b)
	return _prerenderedBackground
}

function syncRoom(
	scene: THREE.Scene,
	node: THREE.Object3D,
	center: THREE.Vector3,
	size: THREE.Vector3,
): THREE.Group | null {
	let hasVr = false
	node.traverse((o: any) => {
		if (
			o.isMesh &&
			o.visible &&
			String(o.name ?? '')
				.toLowerCase()
				.includes('vr_')
		)
			hasVr = true
	})
	const room = ensureProceduralRoom(scene, center, size, { hasVr })
	scene.background = getPrerenderedBackground() as any
	return room
}

function cullExcessLights(root: any, maxLights: number) {
	const lights: any[] = []
	root.traverse((o: any) => {
		if (o.isPointLight) lights.push(o)
	})
	if (lights.length <= maxLights) return null
	lights.sort((a: any, b: any) => (b.intensity || 0) - (a.intensity || 0))
	let culled = 0
	for (const light of lights.slice(maxLights)) {
		// Suppress the light's own render contribution at this snapshot via intensity alone -
		// many lights (bumper/insert lights especially) are legitimately at zero intensity
		// here simply because they're off by default and only turn on later in response to
		// gameplay. Two things this must NOT do, both tried and reverted: (1) removing the
		// node from the scene graph permanently breaks LightUpdater/applyLighting's later
		// state updates, since they look up the 'light' child by traversing obj.children -
		// once removed, gone forever; (2) setting `visible = false` has the same permanent-
		// breakage effect, since applyLighting/_applyLightToTarget only ever touches
		// `.intensity`/`.color`, never `.visible` - a light left invisible here would stay
		// invisible even after a later intensity change turned it back on. Zero intensity
		// alone already fully suppresses a PointLight's contribution, so it's sufficient.
		light.intensity = 0
		culled++
	}
	return { before: lights.length, after: maxLights, culled }
}

export {
	createHarness,
	ensureProceduralRoom,
	filterTextures,
	frameCamera,
	hideCabFlippers,
	postProcessScene,
	resolveVpxCandidates,
}

const cGameName = t => t?.tableScript?.match(/cGameName\s*=\s*["']([^"']+)["']/i)?.[1] || ''
const setTitle = s => {
	const el = document.getElementById('title')
	if (el && s) el.textContent = s
}
export class Viewer {
	constructor(opts = {}) {
		ensureGlobals()
		ensureBvh()
		const { defaultVpx = null, queryParam = 'vpx', dom = {}, viewerMode = 'viewer' } = opts
		this.defaultVpx = defaultVpx
		this.queryParam = queryParam
		this.viewerMode = viewerMode
		this.dom = {
			canvas: dom.canvas || $('canvas'),
			loading: dom.loading || $('loading'),
			barFill: dom.barFill || $('bar-fill'),
			barText: dom.barText || $('bar-text'),
			loadDetail: dom.loadDetail || $('load-detail'),
			loadTitle: dom.loadTitle || $('load-title'),
			subtitle: dom.subtitle || $('subtitle'),
			stats: dom.stats || $('stats'),
			logEl: dom.logEl || $('log'),
			resetBtn: dom.resetBtn || $('reset'),
			wrap: dom.wrap || $('canvas-wrap'),
			dropzone: dom.dropzone || $('dropzone'),
			card: dom.card || $('card'),
			status: dom.status || $('status'),
			fileInput: dom.fileInput || $('file'),
			playTip: dom.playTip || document.getElementById('play-tip'),
			streamWrap: dom.streamWrap || document.getElementById('stream-progress'),
			streamFill: dom.streamFill || document.getElementById('stream-fill'),
			streamText: dom.streamText || document.getElementById('stream-text'),
			streamLabel: dom.streamLabel || document.getElementById('stream-label'),
			nudgeFlash: dom.nudgeFlash || document.getElementById('nudge-flash'),
			fpsHud: dom.fpsHud || document.getElementById('fps-hud'),
			modeHint: dom.modeHint || document.getElementById('mode-hint'),
		}
		this.harnessLog = createHarness(this.dom.logEl).harnessLog
		this.scene = new THREE.Scene()
		this.scene.background = getPrerenderedBackground() as any
		this.camera = new THREE.PerspectiveCamera(
			CAM.fov,
			(typeof window !== 'undefined' ? window.innerWidth : 800) /
				(typeof window !== 'undefined' ? window.innerHeight : 600),
			CAM.near,
			CAM.far,
		)
		this.camera.position.set(0, -800, 1500)
		this.scene.add(new THREE.HemisphereLight(LIGHT_HEMI.sky, LIGHT_HEMI.ground, LIGHT_HEMI.intensity))
		const dir = new THREE.DirectionalLight(LIGHT_DIR.color, LIGHT_DIR.intensity)
		dir.position.set(...LIGHT_DIR.pos)
		this.scene.add(dir)
		this.scene.add(new THREE.AmbientLight(LIGHT_AMBIENT.color, LIGHT_AMBIENT.intensity))
		this.tableGroup = null
		this.table = null
		this.player = null
		this.renderApi = null
		this.nodeCache = new Map()
		this._lightmapMap = new Map()
		this.isPaused = false
		this._boundKeyDown = null
		this._boundKeyUp = null
		this._playCameraApplied = false
		this._cameraTimeout = null
		this._cameraRaf = null
		this.animFrame = null
		this._animRaf = null
		this._animTimeout = null
		this._emuStartLogged = false
		this._streamId = 0
		this._loadId = 0
		this._cameraGen = 0
		this._cameraTimeoutResolver = null
		this._loadAbort = null
		this._touchMap = new Map()
		this._inputCleanup = null
		this._nudgeCleanup = null
		this._touchCleanup = null
		this._hasPinmame = false
		this._rendererBackend = 'webgpu'
		this.renderPipeline = null
		this.renderer = null
		this.controls = null
		this._eventCleanups = []
		this._boundResize = () => this._onResize()
		this._disposed = false
		this._rendererReady = this._createRenderer()
		this.dmd = new DmdRenderer(this)
		if (_isDev)
			Object.assign(window, {
				scene: this.scene,
				camera: this.camera,
				THREE,
			})
		addEventListener('resize', this._boundResize)
		this._eventCleanups.push(() => removeEventListener('resize', this._boundResize))
		{
			const onPopState = () => {
				if (this.viewerMode === 'play') {
					this._switchToViewer()
				}
			}
			addEventListener('popstate', onPopState)
			this._eventCleanups.push(() => removeEventListener('popstate', onPopState))
		}
		{
			const onReset = () => this._onResetView()
			this.dom.resetBtn?.addEventListener('click', onReset)
			if (this.dom.resetBtn)
				this._eventCleanups.push(() => this.dom.resetBtn?.removeEventListener('click', onReset))
		}
		this._setupModeSwitch()
		this._setupDebugToggle()
		this._syncChrome()
		try {
			void import('../../dist-esm/lib/scripting/transpiler-worker-pool.js').then(m => m.warmTranspilerWorker?.())
		} catch {}
	}
	destroy() {
		if (this._disposed) return
		this._disposed = true
		if (this._cameraRaf) cancelAnimationFrame(this._cameraRaf)
		if (this._cameraTimeout) clearTimeout(this._cameraTimeout)
		if (this._animRaf) cancelAnimationFrame(this._animRaf)
		if (this._animTimeout) clearTimeout(this._animTimeout)
		if (this.animFrame) cancelAnimationFrame(this.animFrame)
		if (this.animFrame) clearTimeout(this.animFrame)
		if ((this as any)._physicsTimeout) clearTimeout((this as any)._physicsTimeout)
		this._inputCleanup?.()
		this._inputCleanup = null
		this._nudgeCleanup?.()
		this._nudgeCleanup = null
		this._touchCleanup?.()
		this._touchCleanup = null
		if (this._cameraTimeoutResolver) {
			const _r = this._cameraTimeoutResolver
			this._cameraTimeoutResolver = null
			_r()
		}
		if (this._loadAbort) {
			this._loadAbort.abort()
			this._loadAbort = null
		}
		this._terminatePhysicsWorker()
		for (const fn of this._eventCleanups) fn()
		this._eventCleanups = []
		if (this._boundKeyDown) removeEventListener('keydown', this._boundKeyDown)
		if (this._boundKeyUp) removeEventListener('keyup', this._boundKeyUp)
		this.controls?.dispose?.()
		this.renderPipeline?.dispose?.()
		this.renderer?.setAnimationLoop(null)
		this.renderer?.dispose?.()
		this.scene?.clear?.()
	}
	_terminatePhysicsWorker() {
		this._physicsWorker?.terminate?.()
		this._physicsWorker = null
		this._physicsSab = null
		this._physicsScratch = null
	}
	_setupDebugToggle() {
		const btn = document.getElementById('debug-toggle')
		const toggle = () => document.body.classList.toggle('show-debug')
		if (btn) {
			btn.addEventListener('click', toggle)
			this._eventCleanups.push(() => btn.removeEventListener('click', toggle))
		}
		const onKey = e => {
			if ((e.code === 'Backquote' || e.key === '`' || e.key === 'F2') && !e.ctrlKey && !e.metaKey && !e.altKey) {
				const tag = (document.activeElement?.tagName || '').toLowerCase()
				if (tag === 'input' || tag === 'textarea' || tag === 'select') return
				toggle()
			}
		}
		addEventListener('keydown', onKey)
		this._eventCleanups.push(() => removeEventListener('keydown', onKey))
	}
	async _createRenderer() {
		const canvas = this.dom.canvas
		const p = new URLSearchParams(location.search)
		const wantAA = !p.has('noaa')

		const renderer = new THREE.WebGPURenderer({
			canvas,
			antialias: wantAA,
			powerPreference: 'high-performance',
		})
		await renderer.init()

		renderer.setPixelRatio(getTargetPixelRatio(this.viewerMode))
		renderer.outputColorSpace = THREE.SRGBColorSpace
		renderer.sortObjects = false
		renderer.shadowMap.enabled = false

		applyRendererToneMapping(renderer, this.table?.data, isLowQuality())
		this._globalEmissionScale = Number.isFinite(this.table?.data?.globalEmissionScale)
			? this.table.data.globalEmissionScale
			: 1
		this._applyTableToneMapping = tbl => {
			if (!this.renderer || !tbl?.data) return
			applyRendererToneMapping(this.renderer, tbl.data, isLowQuality())
			this._globalEmissionScale = Number.isFinite(tbl.data.globalEmissionScale) ? tbl.data.globalEmissionScale : 1
			if (this.renderPipeline) {
				this.renderPipeline.updateExposure(clampExposure(tbl.data.exposure, 2))
				this.renderPipeline.updateToneMapper(tbl.data.toneMapper ?? 2)
			}
		}
		this.renderer = renderer
		this._rendererBackend = 'webgpu'
		try {
			this.renderPipeline = new VpxRenderPipeline(renderer, this.scene, this.camera, {
				toneMapper: this.table?.data?.toneMapper,
				exposure: this.table?.data?.exposure,
				bloomEnabled: true,
				bloomStrength: isLowQuality() ? 0.3 : 0.35,
			})
		} catch (e) {
			console.warn('VpxRenderPipeline init failed, falling back to direct render', e)
			this.renderPipeline = null
		}
		this._setupDeviceLifecycle(renderer)
		this.controls?.dispose?.()
		this.controls = new OrbitControls(this.camera, this.renderer.domElement)
		this.controls.enableDamping = true
		this.controls.target.set(0, 0, 0)
		this.controls.update()
		this.controls.enabled = this.viewerMode !== 'play'
		if (_isDev)
			Object.assign(window, {
				scene: this.scene,
				camera: this.camera,
				controls: this.controls,
				renderer: this.renderer,
				THREE,
			})
		this._onResize()
		this.log(`WebGPURenderer ready (three r${String(THREE.REVISION)})`)
		return renderer
	}

	private _setupDeviceLifecycle(renderer) {
		try {
			const device = (renderer as any).backend?.device as GPUDevice | undefined
			if (!device?.lost) return
			device.lost.then((info: any) => {
				console.warn(`[WebGPU] Device lost: reason=${info.reason}, message=${info.message}`)
				if (info.reason !== 'destroyed' && !this._disposed) void this._createRenderer()
			})
		} catch {}
	}

	async precompilePipelines() {
		if (!this.renderer || !this.scene || !this.camera) return
		try {
			this.log('[renderer] pre-compiling WebGPU shader pipelines...', 'info')
			const startTime = performance.now()
			await this.renderer.compileAsync(this.scene, this.camera)
			const duration = (performance.now() - startTime).toFixed(1)
			this.log(`[renderer] WebGPU pipelines compiled in ${duration}ms`, 'info')
		} catch (e) {
			console.warn('[renderer] compileAsync non-fatal warning:', e)
		}
	}

	private _syncPhysicsTransforms(_timestamp) {
		if (!this.player) return
		if (this._physicsSab && this._physicsScratch) trySnap(this._physicsSab, this._physicsScratch)
		this.player.setPhysicsEnabled(this.viewerMode === 'play')
		this.player.updatePhysics()
		if (this.player && this.viewerMode === 'play' && !this.isPaused) {
			this.player.updateAnimations(this.player.getGameTime())
			const changed = this.player.popStates()
			if (!changed.isEmpty) this.applyChangedStates(changed)
			else changed.release()
		}
	}

	stopLoop() {
		this.renderer?.setAnimationLoop(null)
	}
	async _ensureRenderer() {
		await this._rendererReady
		return this.renderer
	}
	_onResetView() {
		if (this.viewerMode === 'play') {
			this._switchToViewer()
			return
		}
		if (!this.tableGroup || !this.controls) return
		const state = computeViewerFraming(this.tableGroup)
		this._animateCameraTo(state, CAM_ANIM.durationReset)
	}
	_onResize() {
		const w = typeof window !== 'undefined' ? window.innerWidth : 800
		const h = typeof window !== 'undefined' ? window.innerHeight : 600
		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()
		const pr = getTargetPixelRatio(this.viewerMode)
		if (this.renderer) this.renderer.setPixelRatio(pr)
		this.renderer?.setSize(w, h)
	}
	_setupModeSwitch() {
		const onOrbitToggle = e => {
			if ((e.key === 'o' || e.key === 'O') && this.viewerMode === 'play') {
				this.controls.enabled = !this.controls.enabled
				this.log(`Orbit ${this.controls.enabled ? 'enabled' : 'disabled'}`)
			}
		}
		addEventListener('keydown', onOrbitToggle)
		this._eventCleanups.push(() => removeEventListener('keydown', onOrbitToggle))
		this._raycaster = new THREE.Raycaster()
		this._raycaster.firstHitOnly = false
		this._mouse = new THREE.Vector2()
		const tip = this.dom.playTip
		const canvas = this.dom.canvas
		let hovered = false
		const hideTip = () => {
			hovered = false
			if (tip) tip.hidden = true
			if (canvas) canvas.classList.remove('is-pointer')
		}
		const showTipAt = (x, y) => {
			if (!tip || this.viewerMode !== 'viewer' || !this.tableGroup) return
			hovered = true
			tip.style.setProperty('--tip-x', `${x}px`)
			tip.style.setProperty('--tip-y', `${y}px`)
			tip.hidden = false
			if (canvas) canvas.classList.add('is-pointer')
		}
		this._hidePlayTip = hideTip
		if (!canvas) return
		const getHits = (x, y) => {
			if (this.viewerMode !== 'viewer' || !this.tableGroup) return []
			const r = canvas.getBoundingClientRect()
			this._mouse.x = ((x - r.left) / r.width) * 2 - 1
			this._mouse.y = -((y - r.top) / r.height) * 2 + 1
			this._raycaster.setFromCamera(this._mouse, this.camera)
			return this._raycaster.intersectObject(this.tableGroup, true)
		}
		const hitTest = (x, y) => getHits(x, y).some((h: any) => isTableHit(h.object, this.tableGroup))
		let hoverRaf = 0
		let hoverX = 0,
			hoverY = 0
		const flushHover = () => {
			hoverRaf = 0
			if (this.viewerMode !== 'viewer' || !this.tableGroup) return hideTip()
			if (this.controls?.state !== -1) return hideTip()
			if (!hitTest(hoverX, hoverY)) return hideTip()
			showTipAt(hoverX, hoverY)
		}
		const onHover = e => {
			hoverX = e.clientX
			hoverY = e.clientY
			if (hoverRaf) return
			hoverRaf = requestAnimationFrame(flushHover)
		}
		canvas.addEventListener('pointermove', onHover)
		canvas.addEventListener('pointerleave', () => {
			if (hoverRaf) cancelAnimationFrame(hoverRaf)
			hoverRaf = 0
			hideTip()
		})
		canvas.addEventListener('click', e => {
			if (this.viewerMode !== 'viewer' || !this.tableGroup || e.button !== 0) return
			if (!hitTest(e.clientX, e.clientY)) return
			this._switchToPlay()
		})
		const onViewerTouchEnd = e => {
			if (this.viewerMode !== 'viewer' || !this.tableGroup) return
			const t = e.changedTouches?.[0]
			if (!t) return
			if (!hitTest(t.clientX, t.clientY)) return
			this._switchToPlay()
			e.preventDefault()
		}
		canvas.addEventListener('touchend', onViewerTouchEnd, { passive: false })
		this._eventCleanups.push(() => canvas.removeEventListener('touchend', onViewerTouchEnd))
	}
	async _switchToPlay() {
		if (this.viewerMode === 'play' || !this.tableGroup) return
		this.viewerMode = 'play'
		if (typeof history !== 'undefined' && history.state?.mode !== 'play') {
			history.pushState({ mode: 'play' }, '')
		}
		if (this.renderer) {
			this.renderer.setPixelRatio(getTargetPixelRatio('play'))
			this.renderer.sortObjects = false
		}
		this._hidePlayTip?.()
		hideCabFlippers(this.tableGroup)
		this._syncChrome()
		if (this.player) {
			this.player.setPhysicsEnabled(true)
			this.enterPlayMode()
		} else {
			this.hookInput()
		}
		this.dom.canvas?.focus()
		const target = computePlayFraming(this.tableGroup)
		await this._animateCameraTo(target, CAM_ANIM.durationMode)
		{
			const fov = Number.isFinite(this.table?.data?.bgFov?.[0]) ? this.table.data.bgFov[0] : CAM.fov
			if (Number.isFinite(fov) && Math.abs(this.camera.fov - fov) > 0.5) {
				this.camera.fov = Math.max(20, Math.min(70, fov))
				this.camera.updateProjectionMatrix()
			}
		}
		{
			const framing = computePlayFraming(this.tableGroup)
			syncRoom(this.scene, this.tableGroup, framing.center, framing.size)
		}
		if (!this.player) {
			if (this.table) await this._createPlayer()
			else this.load().catch(e => this.log(`Play load failed: ${e.message}`, 'error'))
		}
	}
	async _switchToViewer() {
		if (this.viewerMode !== 'play' || !this.tableGroup) return
		this.viewerMode = 'viewer'
		if (typeof history !== 'undefined' && history.state?.mode === 'play') {
			history.back()
		}
		if (this.renderer) this.renderer.setPixelRatio(getTargetPixelRatio('viewer'))
		this._hidePlayTip?.()
		showCabFlippers(this.tableGroup)
		this._syncChrome()
		const target = computeViewerFraming(this.tableGroup)
		await this._animateCameraTo(target, CAM_ANIM.durationMode)
		if (Math.abs(this.camera.fov - CAM.fov) > 0.5) {
			this.camera.fov = CAM.fov
			this.camera.updateProjectionMatrix()
		}
		if (this.tableGroup)
			syncRoom(this.scene, this.tableGroup, target.center, (target as any).size || new THREE.Vector3(1, 1, 1))
		if (this.player) this.player.setPhysicsEnabled(false)
		this.exitPlayMode()
	}
	_syncChrome() {
		const hint = this.dom.modeHint
		const isPlay = this.viewerMode === 'play'
		document.body.classList.toggle('is-play', isPlay)
		renderModeHint(hint, isPlay)
	}
	setupPlayCamera() {
		if (!this.tableGroup || !this.controls) return
		const state = computePlayFraming(this.tableGroup)
		applyCameraState(this.camera, this.controls, state)
		{
			const fov = Number.isFinite(this.table?.data?.bgFov?.[0]) ? this.table.data.bgFov[0] : CAM.fov
			if (Number.isFinite(fov) && Math.abs(this.camera.fov - fov) > 0.5) {
				this.camera.fov = Math.max(20, Math.min(70, fov))
				this.camera.updateProjectionMatrix()
			}
		}
		this._playCameraApplied = true
	}
	async _animateCameraTo(state, duration = CAM_ANIM.durationMode) {
		if (!state || !this.controls) return
		this._cameraGen = (this._cameraGen ?? 0) + 1
		const _gen = this._cameraGen
		if (this._cameraRaf) {
			cancelAnimationFrame(this._cameraRaf)
			this._cameraRaf = null
		}
		if (this._cameraTimeout) {
			clearTimeout(this._cameraTimeout)
			this._cameraTimeout = null
		}
		if (this._cameraTimeoutResolver) {
			const _r = this._cameraTimeoutResolver
			this._cameraTimeoutResolver = null
			_r()
		}
		const fromPos = this.camera.position.clone()
		const fromTarget = this.controls.target.clone()
		const fromNear = this.camera.near
		const fromFar = this.camera.far
		const fromFov = this.camera.fov
		const toPos = state.position.clone()
		const toTarget = state.target.clone()
		const toNear = state.near
		const toFar = state.far
		const toFov = (() => {
			if (this.viewerMode === 'play') {
				const f = Number.isFinite(this.table?.data?.bgFov?.[0]) ? this.table.data.bgFov[0] : CAM.fov
				return Number.isFinite(f) ? Math.max(20, Math.min(70, f)) : CAM.fov
			}
			return CAM.fov
		})()
		if (
			fromPos.distanceTo(toPos) < 0.5 &&
			fromTarget.distanceTo(toTarget) < 0.5 &&
			Math.abs(fromFov - toFov) < 0.1
		) {
			applyCameraState(this.camera, this.controls, state)
			if (Math.abs(this.camera.fov - toFov) > 0.1) {
				this.camera.fov = toFov
				this.camera.updateProjectionMatrix()
			}
			this._playCameraApplied = this.viewerMode === 'play'
			return
		}
		const ease = t => t * t * (3 - 2 * t)
		const prevDamping = this.controls.enableDamping
		this.controls.enableDamping = false
		this.controls.enabled = false
		this.gate ??= new AnimationGate()
		this.gate.beginAnimation()
		const start = performance.now()
		return new Promise(resolve => {
			const tick = () => {
				if (_gen !== this._cameraGen) {
					this.gate.endAnimation()
					this.controls.enableDamping = prevDamping
					this.controls.enabled = this.viewerMode !== 'play'
					resolve()
					return
				}
				if (this._disposed) {
					this.gate.endAnimation()
					this.controls.enableDamping = prevDamping
					resolve()
					return
				}
				const t = Math.min(1, (performance.now() - start) / duration)
				const e = ease(t)
				this.camera.position.lerpVectors(fromPos, toPos, e)
				this.controls.target.lerpVectors(fromTarget, toTarget, e)
				this.camera.near = THREE.MathUtils.lerp(fromNear, toNear, e)
				this.camera.far = THREE.MathUtils.lerp(fromFar, toFar, e)
				this.camera.fov = THREE.MathUtils.lerp(fromFov, toFov, e)
				this.camera.updateProjectionMatrix()
				this.camera.lookAt(this.controls.target)
				this.controls.update()
				if (t < 1) this._cameraRaf = requestAnimationFrame(tick)
				else {
					this._cameraRaf = null
					applyCameraState(this.camera, this.controls, state)
					if (Math.abs(this.camera.fov - toFov) > 0.1) {
						this.camera.fov = toFov
						this.camera.updateProjectionMatrix()
					}
					this._playCameraApplied = this.viewerMode === 'play'
					this.controls.enableDamping = prevDamping
					this.controls.enabled = this.viewerMode !== 'play'
					this.gate.endAnimation()
					resolve()
				}
			}
			this._cameraRaf = requestAnimationFrame(tick)
		})
	}
	_createPhysicsWorker() {
		try {
			if (this._physicsWorker) this._physicsWorker.terminate()
			const sab = createPhysicsSAB()
			const scratch = new Float32Array(MAX_BALLS * BALL_STRIDE)
			const workerUrl = new URL('../../dist-esm/lib/game/physics.worker.js', import.meta.url)
			const worker = new Worker(workerUrl, {
				type: 'module',
			})
			worker.postMessage({
				type: 'init',
				sab,
			})
			worker.postMessage({
				type: 'start',
			})
			worker.onerror = e => {
				this.log(`worker error ${e.message}`, 'warn')
				this._physicsSab = null
				worker.terminate()
				if (this._physicsWorker === worker) this._physicsWorker = null
			}
			this._physicsSab = sab
			this._physicsScratch = scratch
			this._physicsWorker = worker
			return {
				sab,
				scratch,
				worker,
			}
		} catch (e) {
			this.log(`physics worker init failed ${e.message}`, 'warn')
			if (_isDev) console.warn(e)
			return null
		}
	}
	_ensurePhysicsWorker() {
		if (this._physicsSab && this._physicsWorker) return true
		if (!this.player) return false
		const res = this._createPhysicsWorker()
		if (!res) return false
		this.log(`[physics] SAB ${res.sab.byteLength} worker started`, 'info')
		return true
	}
	enterPlayMode() {
		if (this.renderer) this.renderer.shadowMap.enabled = false
		if (this.controls) this.controls.enabled = false
		this._ensurePhysicsWorker()
		if (this.tableGroup) hideCabFlippers(this.tableGroup)
		{
			const framing = this.tableGroup ? computePlayFraming(this.tableGroup) : null
			const center = framing?.center ?? new THREE.Vector3()
			const size = framing?.size ?? new THREE.Vector3(1000, 2000, 500)
			syncRoom(this.scene, this.tableGroup ?? this.scene, center, size)
		}
		const bg = this.tableGroup?.getObjectByName('balls')
		if (bg) bg.visible = true
		this.player?.setPhysicsEnabled(true)
		this._emitModeChange()
		if (this.dom.canvas) {
			this.dom.canvas.tabIndex = 0
			this.dom.canvas.focus()
		}
		this.hookInput()
		if (!this._blurHandler) {
			this._blurHandler = () => {
				this.player?.onKeyUp({ code: 'ShiftLeft', key: 'Shift', ts: Date.now(), location: 1 })
				this.player?.onKeyUp({ code: 'ShiftRight', key: 'Shift', ts: Date.now(), location: 2 })
				this.player?.onKeyUp({ code: 'Shift', key: 'Shift', ts: Date.now() })
			}
			window.addEventListener('blur', this._blurHandler)
			document.addEventListener('visibilitychange', () => {
				if (document.hidden) this._blurHandler()
			})
		}
	}
	exitPlayMode() {
		for (const code of this._touchMap.values()) {
			this.player?.onKeyUp({
				code,
				key: code === 'Enter' ? 'Enter' : 'Shift',
				ts: Date.now(),
			})
		}
		this._touchMap.clear()
		this.player?.onKeyUp({ code: 'ShiftLeft', key: 'Shift', ts: Date.now(), location: 1 })
		this.player?.onKeyUp({ code: 'ShiftRight', key: 'Shift', ts: Date.now(), location: 2 })
		if (this.controls) this.controls.enabled = true
		if (this.tableGroup) showCabFlippers(this.tableGroup)
		const bg = this.tableGroup?.getObjectByName('balls')
		if (bg) bg.visible = false
		this._emitModeChange()
	}
	buildNodeCache() {
		this.nodeCache.clear()
		this._lightmapMap = new Map()
		if (!this.tableGroup || !this.table) return
		for (const name of Object.keys(this.table.items)) {
			if (
				this.viewerMode === 'play' &&
				name.toLowerCase().includes('vrcab') &&
				name.toLowerCase().includes('flipper')
			)
				continue
			const item = this.table.items[name]
			const node = this.tableGroup.getObjectByName(name) || this.tableGroup.getObjectByName(name.toLowerCase())
			if (item?.getUpdater && node) this.nodeCache.set(name, { item, node })
		}
		for (const [primName, prim] of Object.entries(this.table.primitives ?? {})) {
			const lm = prim?.data?.szLightmap
			if (!lm) continue
			const list = this._lightmapMap.get(lm)
			if (list) list.push(primName)
			else this._lightmapMap.set(lm, [primName])
		}
	}
	handleBallLifecycle(ball, created) {
		const ballsGroup = this.tableGroup?.getObjectByName('balls')
		if (!ballsGroup || !ball) return
		if (created) {
			const meshes = ball.getMeshes(this.table, this.renderApi, {})
			const group = this.renderApi.createParentNode(ball.getName())
			for (const obj of Object.values(meshes)) group.add(this.renderApi.createMesh(obj))
			ballsGroup.add(group)
			group.traverse(o => {
				if (o.isMesh) {
					o.castShadow = true
					o.receiveShadow = false
					o.frustumCulled = false
				}
			})
			group.frustumCulled = false
			this.nodeCache.set(ball.getName(), {
				item: ball,
				node: group,
			})
			ball.getUpdater().applyState(group, ball.getState(), this.renderApi, this.table)
			if (this.viewerMode !== 'play') ballsGroup.visible = false
		} else {
			const entry = this.nodeCache.get(ball.getName())
			if (entry?.node) ballsGroup.remove(entry.node)
			this.nodeCache.delete(ball.getName())
		}
	}
	applyChangedStates(changed) {
		if (!changed || !this.tableGroup || !this.renderApi) {
			changed?.release?.()
			return
		}
		const states = changed.changedStates
		const changedLightNames = new Set()
		for (const name in states) {
			const state = states[name]
			if (!state) continue
			if (this.table.lights?.[name]) changedLightNames.add(name)
			const entry = this.nodeCache.get(name)
			if (!entry) continue
			entry.item.getUpdater().applyState(entry.node, state, this.renderApi, this.table)
		}
		if (changedLightNames.size) {
			for (const lm of changedLightNames) {
				const primNames = this._lightmapMap.get(lm)
				if (!primNames) continue
				for (const primName of primNames) {
					const entry = this.nodeCache.get(primName)
					if (!entry) continue
					entry.item.getUpdater().applyState(entry.node, {}, this.renderApi, this.table)
				}
			}
		}
		changed.release()
	}
	_emitModeChange() {
		document.dispatchEvent(
			new CustomEvent('viewer:modechange', {
				detail: {
					mode: this.viewerMode,
				},
			}),
		)
	}
	log(msg, level = 'info') {
		this.harnessLog?.(msg, level)
	}
	setBar(pct, txt) {
		if (this.dom.barFill) this.dom.barFill.style.setProperty('--progress', String(Math.max(0, Math.min(100, pct))))
		if (this.dom.barText) this.dom.barText.textContent = txt ?? `${pct.toFixed(0)}%`
	}
	_loading(pct, title, detail = '') {
		this.setBar(pct, title)
		if (this.dom.loadTitle) this.dom.loadTitle.textContent = title
		if (this.dom.loadDetail) this.dom.loadDetail.textContent = detail
	}
	_setStreamProgress(done, total) {
		const pct = total ? Math.round((done / total) * 100) : 0
		if (this.dom.streamFill) this.dom.streamFill.style.setProperty('--progress', String(pct))
		if (this.dom.streamText) this.dom.streamText.textContent = total ? `${done}/${total} · ${pct}%` : `${pct}%`
	}
	_showStream() {
		const w = this.dom.streamWrap
		if (!w) return
		w.hidden = false
		requestAnimationFrame(() => w.classList.add('show'))
	}
	_hideStream() {
		const w = this.dom.streamWrap
		if (!w) return
		w.classList.remove('show')
		setTimeout(() => {
			if (!w.classList.contains('show')) w.hidden = true
		}, 400)
	}
	_showCanvas() {
		if (this.dom.dropzone) this.dom.dropzone.hidden = true
		if (this.dom.wrap) this.dom.wrap.hidden = false
		if (this.dom.loading) this.dom.loading.hidden = true
		this.renderer?.setSize(
			typeof window !== 'undefined' ? window.innerWidth : 800,
			typeof window !== 'undefined' ? window.innerHeight : 600,
		)
		this.dom.canvas?.focus()
	}
	_setStatus(msg) {
		if (this.dom.subtitle) this.dom.subtitle.textContent = msg
		if (this.dom.status) this.dom.status.textContent = msg
	}
	async _loadTable(reader) {
		logMem(this.harnessLog, 'after reader.open')
		this._loading(66, 'Opening table…', 'Reading table data…')
		const t0 = performance.now()
		const table = await Table.load(reader)
		this.table = table
		this._applyTableToneMapping?.(table)
		if (_isDev) window.table = table
		this._hasPinmame = !!cGameName(table)
		const dt = performance.now() - t0
		this.log(
			`Parsed in ${dt.toFixed(0)}ms — ${Object.keys(table.items).length} items, ${Object.keys(table.textures).length} textures`,
		)
		logMem(this.harnessLog, 'after parse')
		filterTextures(table, this.log.bind(this))
		return table
	}
	async _buildScene(table) {
		this._setStatus('')
		this._loading(70, 'Building playfield…', 'Preparing visuals…')
		const g = table.data.globalEmissionScale
		if (Number.isFinite(g)) setGlobalEmissionScale(g)
		const texLoader = new ThreeTextureLoaderBrowser()
		const renderApi = new ThreeRenderApi(
			{
				applyMaterials: true,
				applyTextures: texLoader,
				optimizeTextures: false,
			},
			(this.gate ??= new AnimationGate()),
		)
		this.renderApi = renderApi
		if (_isDev) window.renderApi = renderApi
		if (_isDev) window.textureLoader = texLoader
		const ballTex = await texLoader.loadDefaultTexture('ball.png', '.png', 'ball.png')
		renderApi.getMapGenerator().getCache().set('ball.png', ballTex)
		ballTex.name = 'texture:ball.png'
		await Promise.all(
			[
				'bumperbase.png',
				'bumperCap.png',
				'bumperring.png',
				'bumperskirt.png',
				'kickerCup.png',
				'kickerGottlieb.png',
				'kickerHoleWood.png',
				'kickerT1.png',
				'kickerWilliams.png',
			].map(async nm => {
				const t = await texLoader.loadDefaultTexture(nm, '.png', nm)
				renderApi.getMapGenerator().getCache().set(nm, t)
				t.name = `texture:${nm}`
				renderApi.getMapGenerator().getCache().set(nm.toLowerCase(), t)
			}),
		)
		let textures = []
		{
			const all = Object.values(table.textures)
			const high = all.filter(tx => !isDeferred(tx, table))
			const deferred = all.filter(tx => isDeferred(tx, table))
			high.sort((a, b) => a.width * a.height - b.width * b.height)
			deferred.sort((a, b) => a.width * a.height - b.width * b.height)
			textures = [...high, ...deferred]
			const pf = table.getPlayfieldMap()?.toLowerCase()
			if (pf) {
				const idx = textures.findIndex(tx => tx.getName().toLowerCase() === pf)
				if (idx > 0) {
					const [pfTx] = textures.splice(idx, 1)
					textures.unshift(pfTx)
				} else if (idx === -1) {
					const best = [...textures].sort((a, b) => b.width * b.height - a.width * a.height)[0]
					if (best) {
						const fIdx = textures.indexOf(best)
						if (fIdx > 0) {
							const [f] = textures.splice(fIdx, 1)
							textures.unshift(f)
						}
						this.log(
							`[stream] Playfield map "${pf}" missing — fallback to largest "${best.getName()}"`,
							'warn',
						)
					}
				}
			}
			if (textures.length) {
				this.log(
					`[stream] ${high.length} high-prio + ${deferred.length} deferred — streaming ${textures.length}`,
				)
			}
		}
		this._loading(78, 'Assembling cabinet…', 'Building the machine…')
		const t0 = performance.now()
		const node = await table.generateTableNode(renderApi, {
			...TABLE_OPTS,
			preloadTextures: false,
		})
		{
			const maxLights = getMaxLights()
			const culled = cullExcessLights(node, maxLights)
			if (culled)
				this.log(
					`[quality] ${isLowQuality() ? 'low' : 'high'} — lights ${culled.before} → ${culled.after} (culled ${culled.culled})`,
					'info',
				)
		}
		{
			const pfLower = table.getPlayfieldMap()?.toLowerCase()
			const hasPfTex = pfLower ? !!table.getTexture(pfLower) : false
			const hasBM = (() => {
				let found = false
				node.traverse(o => {
					if (found) return
					if ((o.name || '').toLowerCase().includes('bm_playfield')) found = true
				})
				return found
			})()
			if (!hasPfTex && !hasBM) {
				const best = Object.values(table.textures).sort((a, b) => b.width * b.height - a.width * a.height)[0]
				if (best) {
					node.traverse(o => {
						if (!o.isMesh || o.name !== 'primitive-playfield_mesh') return
						const mat = o.material
						if (!mat || mat.map || mat.userData?.pendingMap) return
						mat.userData.pendingMap = best.getName()
						mat.userData.__isBaked = true
						mat.needsUpdate = true
					})
					if (best) this.log(`[playfield] Patched missing "${pfLower}" with "${best.getName()}"`, 'info')
				}
			}
		}
		const dt = performance.now() - t0
		let tris = 0,
			draws = 0
		node.traverse(o => {
			if (o.isMesh && o.geometry?.attributes?.position) {
				tris += o.geometry.attributes.position.count / 3
				draws++
			}
		})
		this.log(
			`Scene generated in ${dt.toFixed(0)}ms — ${countObjects(node)} objects, ${Math.round(tris)} tris, ${draws} draws`,
		)
		const { texCount, texMemMB } = computeTexMem(node)
		this.log(`Textures in scene: ${texCount} ~${texMemMB} MB`)
		this._loading(88, 'Finishing up…', 'Final touches…')
		logMem(this.harnessLog, 'after generateTableNode')
		if (textures.length) {
			const used = new Set()
			const mainBakeUsed = new Set()
			node.traverse(o => {
				if (!o.isMesh || !o.material) return
				const n = (o.name || '').toLowerCase()
				const isMainBake = n.includes('playfield') && (n.includes('bm_') || RE_BAKE_MAP.test(n))
				const mats = Array.isArray(o.material) ? o.material : [o.material]
				for (const m of mats) {
					for (const k of ['map', 'normalMap', 'envMap', 'emissiveMap']) {
						const pending = m.userData?.[`pending${k[0].toUpperCase()}${k.slice(1)}`]
						if (pending) {
							const key = String(pending).toLowerCase()
							used.add(key)
							if (isMainBake) mainBakeUsed.add(key)
						}
						const tex = m[k]
						if (tex?.name) {
							const key = String(tex.name)
								.replace(/^texture:/, '')
								.toLowerCase()
							used.add(key)
							if (isMainBake) mainBakeUsed.add(key)
						}
					}
				}
			})
			const pf2 = table.getPlayfieldMap()?.toLowerCase()
			const before = textures.length
			const keepAllInserts = n =>
				n.includes('insert') ||
				n.includes('round') ||
				n.includes('rect') ||
				n.includes('switc') ||
				n.includes('vrlight') ||
				n.includes('flasher') ||
				n.includes('scratches') ||
				n.includes('ball_') ||
				n.includes('bumper') ||
				n.includes('kicker') ||
				n.includes('bump')
			textures = textures.filter(tx => {
				const n = tx.getName().toLowerCase()
				if (used.has(n) || (pf2 && n === pf2)) return true
				if (keepAllInserts(n)) return true
				return false
			})
			if (textures.length !== before)
				this.log(`[stream] Filtered ${before} → ${textures.length} used textures (kept inserts)`)
			{
				const keepSet = new Set(textures.map(tx => tx.getName().toLowerCase()))
				let cleared = 0
				for (const tx of Object.values(table.textures) as any[]) {
					const n = tx.getName().toLowerCase()
					if (!keepSet.has(n)) {
						if (tx.binary || tx.pdsBuffer) cleared++
						tx.binary = undefined
						tx.pdsBuffer = undefined
					}
				}
				if (cleared) {
					this.log(`[mem] Eagerly cleared ${cleared} unused raw texture buffers`, 'info')
					if (typeof (window as any).gc === 'function') (window as any).gc()
				}
			}
			textures.sort((a, b) => {
				const aN = a.getName().toLowerCase(),
					bN = b.getName().toLowerCase()
				if (aN === pf2 && bN !== pf2) return -1
				if (bN === pf2 && aN !== pf2) return 1
				const aMain = mainBakeUsed.has(aN) ? 0 : 1,
					bMain = mainBakeUsed.has(bN) ? 0 : 1
				if (aMain !== bMain) return aMain - bMain
				const aCab =
					aN.includes('vrcab') || aN.includes('vr_') || aN.includes('lockbar') || aN.includes('cabinet')
						? 0
						: 1
				const bCab =
					bN.includes('vrcab') || bN.includes('vr_') || bN.includes('lockbar') || bN.includes('cabinet')
						? 0
						: 1
				if (aCab !== bCab) return aCab - bCab
				if (aMain === 0) return b.width * b.height - a.width * a.height
				if (aCab === 0) return b.width * b.height - a.width * a.height
				return a.width * a.height - b.width * b.height
			})
			if (mainBakeUsed.size)
				this.log(
					`[stream] Prioritized ${mainBakeUsed.size} main-bake: ${[...mainBakeUsed].slice(0, 10).join(', ')}`,
				)
			this.log(`[stream] ${textures.length} textures pending — streaming`)
		}
		return {
			node,
			textures,
		}
	}
	async _cleanupReader(reader) {
		if (reader.release) await reader.release()
		else await reader.close()
		reader.data = undefined
		reader.blob = undefined
		if (typeof (window as any).gc === 'function') (window as any).gc()
		logMem(this.harnessLog, 'after reader release')
	}
	_clearRawTextures() {
		let n = 0
		if (!this.table?.textures) return
		for (const k of Object.keys(this.table.textures)) {
			this.table.textures[k].binary = undefined
			this.table.textures[k].pdsBuffer = undefined
			n++
		}
		if (n) this.harnessLog?.(`[mem] Cleared ${n} raw texture buffers`, 'info')
	}
	async _mount(table, node, opts = {}, source = null) {
		if (this.tableGroup) this.scene.remove(this.tableGroup)
		this.tableGroup = node
		this._tableBasePos = node.position.clone()
		this.scene.add(node)
		const pp = postProcessScene(node, {
			viewerMode: this.viewerMode,
			harnessLog: this.harnessLog,
			table,
		})
		if (this.viewerMode === 'play') hideCabFlippers(node)
		const params = new URLSearchParams(location.search)
		const useBatch = !params.has('nobatched')
		if (useBatch && table && this.renderApi) {
			const res = _optimizeScene(node, table, this.renderApi)
			if ((res.batched || res.instanced) && this.harnessLog) {
				const before = (() => {
					let c = 0
					node.traverse(o => {
						if (o.isMesh) c++
					})
					return c
				})()
				this.harnessLog(
					`[batch] BatchedMesh ${res.batched} + Instanced ${res.instanced} — meshes ${before}`,
					'info',
				)
			}
		}
		this.buildNodeCache()
		this.dmd._ensureTexture()
		this.dmd.findMeshes()
		let framed
		if (opts.skipCamera)
			framed = {
				center: this.controls.target.clone(),
				size: new THREE.Vector3(),
				maxDim: 1,
			}
		else if (this.viewerMode === 'play') {
			const state = computePlayFraming(this.tableGroup)
			applyCameraState(this.camera, this.controls, state)
			{
				const fov = Number.isFinite(this.table?.data?.bgFov?.[0]) ? this.table.data.bgFov[0] : CAM.fov
				if (Number.isFinite(fov) && Math.abs(this.camera.fov - fov) > 0.5) {
					this.camera.fov = Math.max(20, Math.min(70, fov))
					this.camera.updateProjectionMatrix()
				}
			}
			this._playCameraApplied = true
			framed = {
				center: state.center,
				size: state.size,
				maxDim: state.maxDim,
			}
			this.harnessLog?.(
				`[mount] play cam ${state.position.x.toFixed(0)},${state.position.y.toFixed(0)},${state.position.z.toFixed(0)} tgt ${state.target.x.toFixed(0)},${state.target.y.toFixed(0)},${state.target.z.toFixed(0)} maxDim ${state.maxDim.toFixed(0)}`,
				'info',
			)
		} else {
			framed = frameCamera(this.tableGroup, this.camera, this.controls)
			if (Math.abs(this.camera.fov - CAM.fov) > 0.5) {
				this.camera.fov = CAM.fov
				this.camera.updateProjectionMatrix()
			}
		}
		const center = framed.center,
			size = framed.size || new THREE.Vector3(1, 1, 1)
		syncRoom(this.scene, node, center, size)
		this._showCanvas()
		this.log(
			`Framed ${pp.lightmaps ? `(hid ${pp.lightmaps} lm)` : ''} — ${this.tableGroup ? countObjects(this.tableGroup) : 0} objs`.trim(),
		)
		logMem(this.harnessLog, 'Ready — streaming textures')
		this._emitModeChange()
		const gn = cGameName(table)
		const src =
			(opts && typeof opts.source === 'string' ? opts.source : null) ?? (typeof source === 'string' ? source : '')
		const basename =
			typeof src === 'string' && src
				? src
						.split('/')
						.pop()
						?.replace(/\.vpx$/i, '')
				: ''
		const rawGet = table?.getName?.()
		const infoName = table?.info?.TableName?.trim()
		let vpxName = ''
		if (rawGet && rawGet !== 'Table' && rawGet !== 'Table1') vpxName = rawGet
		else if (
			infoName &&
			infoName !== 'Table Name' &&
			infoName !== 'Table1' &&
			infoName.toLowerCase() !== 'table name'
		)
			vpxName = infoName
		else if (basename) vpxName = basename.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
		if (vpxName) setTitle(vpxName)
		else if (gn) setTitle(gn)
		if (gn) {
			const romParam = new URLSearchParams(location.search).get('rom')
			const candidates = romParam ? resolveRomCandidates(romParam) : [`/pinmame/roms/${gn}.zip`]
			this.log(`PinMAME GameName: ${gn} — trying ${candidates.join(', ')}`)
		}
		if (this.dom.subtitle) this.dom.subtitle.textContent = ''
		if (!opts.skipPlayer) {
			this._loading(92, 'Almost ready…', 'Starting game logic…')
			await new Promise(r => setTimeout(r, 0))
			await this._createPlayer()
			this._loading(100, 'Ready!', 'Ready to play')
			if (this.dom.loadTitle)
				this.dom.loadTitle.textContent =
					this.viewerMode === 'play'
						? 'Ready — PLAY: Enter=plunger (hold), ←/→ or A/D flippers, 1=Start 5=Coin, Touch tap left/right hold plunger, P=Pause Esc=viewer ?=help'
						: 'Ready — VIEWER: drag to orbit, wheel to zoom — click table to Play (Esc to return)'
			this.log(this.dom.loadTitle.textContent)
			logMem(this.harnessLog, 'Ready final')
		} else {
			this._loading(88, 'Finishing up…', 'Finishing up…')
		}
		if (_isDev)
			Object.assign(window, {
				table,
				tableGroup: node,
				player: this.player,
			})
		if (!isLowQuality()) buildBvhIdle(node)
		else this.log('[bvh] low quality: skip idle BVH for perf', 'debug')
		this._buttonMeshes = []
		node.traverse(o => {
			if (o.isMesh && o.userData?.isCabinetButton) this._buttonMeshes.push(o)
		})
		if (this._buttonMeshes.length)
			this.harnessLog?.(`[input] ${this._buttonMeshes.length} cabinet button meshes (BVH)`, 'info')
		this.startLoop()
		if (this.viewerMode === 'viewer') {
			const p = new URLSearchParams(location.search)
			const hasVpx = !!(p.get('vpx') || p.get('table'))
			const mode = p.get('mode')
			if (hasVpx && mode === 'play') {
				this.log('[viewer] auto-switch to play (vpx URL)', 'info')
				setTimeout(() => {
					this._switchToPlay()
				}, 600)
			}
		}
		return {
			loaded: table,
			node,
			pp,
			framed,
		}
	}
	async _createPlayer() {
		if (this.player) this.player.removeAllListeners?.()
		this.player = new Player(this.table, (this.gate ??= new AnimationGate()))
		this.player.setPhysicsEnabled(this.viewerMode === 'play')
		const p = this.player
		if (typeof p.initAsync === 'function') await p.initAsync()
		else this.player.init()
		this.nodeCache.clear()
		this.buildNodeCache()
		let ballsGroup = this.tableGroup?.getObjectByName('balls')
		if (!ballsGroup && this.tableGroup && this.renderApi) {
			ballsGroup = this.renderApi.createParentNode('balls')
			this.tableGroup.add(ballsGroup)
		}
		for (const b of this.player.balls) this.handleBallLifecycle(b, true)
		if (ballsGroup) ballsGroup.visible = this.viewerMode === 'play'
		this.player.updateAnimations(this.player.getGameTime() ?? this.player.getPhysics().timeMsec ?? 0)
		const init = this.player.popStates()
		this.applyChangedStates(init)
		this.dmd._ensureTexture()
		this.dmd.findMeshes()
		this.player.on('ballCreated', b => this.handleBallLifecycle(b, true))
		this.player.on('ballDestroyed', b => this.handleBallLifecycle(b, false))
		this.player.on('emuStarted', () => {
			this._emuStartLogged = true
			this.log(`PinMAME emu ready: ${this.player.getPhysics().emu?.constructor.name}`)
		})
		let tries = 0
		const fallback = async () => {
			try {
				let emu = this.player.getPhysics().emu
				if (emu) {
					this.log(
						`Emu after init: ${emu.constructor.name} init=${emu.isInitialized?.()} mock=${emu.isMock} run=${(() => {
							try {
								return emu.api?.isRunning?.()
							} catch {
								return '?'
							}
						})()}`,
					)
					return
				}
				if (++tries < 10) {
					setTimeout(fallback, 1000)
					return
				}
				const gn = cGameName(this.table)
				if (!gn) return
				this.log(`PinMAME: no emu yet for ${gn} — trying manual fallback`, 'warn')
				const { VpmController } = await import('../../dist-esm/lib/scripting/objects/vpm-controller.js')
				if (this.player.getPhysics().emu) return
				const vpm = new VpmController(this.player)
				vpm.GameName = gn
				await vpm.whenReady()
				emu = this.player.getPhysics().emu
				if (emu) {
					this._emuStartLogged = true
					this.log(`PinMAME fallback emu ready: ${emu.constructor.name} init=${emu.isInitialized()}`)
					this.dmd._ensureTexture()
					this.dmd.findMeshes()
				}
			} catch (e) {
				this.log(`PinMAME fallback failed: ${e.message}`, 'warn')
			}
		}
		setTimeout(fallback, 3000)
		this.log('Player init OK')
		this.isPaused = false
		this.hookInput()
		if (this.viewerMode === 'play') this.enterPlayMode()
		else this.exitPlayMode()
	}
	_streamTextures(table, textures, reader) {
		if (!textures?.length) {
			if (reader) void this._cleanupReader(reader).catch(() => {})
			// generic: free raw texture binaries after streaming regardless of mode; keeps GPU textures only
			this._clearRawTextures?.()
			if (typeof (globalThis as any).gc === 'function') (globalThis as any).gc()
			return
		}
		this._showStream()
		this._setStreamProgress(0, textures.length)
		if (this.dom.streamLabel) this.dom.streamLabel.textContent = 'Enhancing visuals…'
		const streamId = ++this._streamId
		void (async () => {
			const total = textures.length
			let done = 0
			const t0 = performance.now()
			this.log(`[stream] Streaming ${total} textures…`)
			let scheduled = false
			const patchCloned = () => {
				const cache = this.renderApi.getMapGenerator?.().getCache?.()
				if (!cache || !this.tableGroup) return 0
				let fixed = 0
				this.tableGroup.traverse(o => {
					if (!o.isMesh || !o.material) return
					const mats = Array.isArray(o.material) ? o.material : [o.material]
					for (const m of mats) {
						for (const k of ['map', 'normalMap', 'envMap', 'emissiveMap']) {
							const pk = `pending${k[0].toUpperCase()}${k.slice(1)}`
							const name = m.userData?.[pk]
							if (!name) continue
							let tex = cache.get(name)
							if (!tex) {
								for (const [ck, cv] of cache)
									if (ck.toLowerCase() === String(name).toLowerCase()) {
										tex = cv
										break
									}
							}
							if (!tex) continue
							m[k] = tex
							tex.name = name
							delete m.userData[pk]
							m.needsUpdate = true
							if (k === 'map' || k === 'emissiveMap') {
								const info = isBakedMeshByNames(
									o.name || '',
									m.name || '',
									tex.name || '',
									!!m.userData?.__isBaked,
									!!m.userData?.__addBlend,
								)
								if (info.isBaked) {
									applyBakedMaterial(m, tex, info, o.name || '')
									const nl = (o.name || '').toLowerCase()
									const isBakedMeshName = nl.includes('playfield') || nl.includes('bm_')
									if (info.isMainBake && isBakedMeshName) {
										const makeVisible = obj => {
											if (obj.visible === false) {
												obj.visible = true
												for (let pp = obj.parent; pp && pp !== this.tableGroup; pp = pp.parent)
													if (pp.visible === false) pp.visible = true
											}
										}
										makeVisible(o)
										this.tableGroup.traverse(obj2 => {
											if (!obj2.isMesh || obj2 === o) return
											const n2 = (obj2.name || '').toLowerCase()
											if (obj2.material === m && n2.includes('bm_')) {
												makeVisible(obj2)
											}
										})
									}
								} else if (info.isVrCab) {
									const nl = (o.name || '').toLowerCase()
									if (
										o.visible === false &&
										(nl.includes('vrcab') ||
											nl.includes('cabinet') ||
											nl.includes('lockbar') ||
											nl.includes('pincab'))
									) {
										o.visible = true
										for (let p = o.parent; p && p !== this.tableGroup; p = p.parent)
											if (p.visible === false) p.visible = true
									}
									m.polygonOffset = true
									m.polygonOffsetFactor = 0
									m.polygonOffsetUnits = -1
									if (m.transparent && m.opacity === 0) {
										m.transparent = false
										m.opacity = 1
										m.depthWrite = true
										m.alphaTest = 0
										m.blending = THREE.NormalBlending
										if (tex) {
											tex.wrapS = THREE.ClampToEdgeWrapping
											tex.wrapT = THREE.ClampToEdgeWrapping
											tex.generateMipmaps = true
											tex.minFilter = THREE.LinearMipmapLinearFilter
											tex.magFilter = THREE.LinearFilter
											tex.anisotropy = isLowQuality() ? QUALITY_CAPS.low.aniso : 8
											tex.needsUpdate = true
										}
										m.needsUpdate = true
									}
									m.needsUpdate = true
								} else {
									const texName = String(tex?.name ?? name ?? '').toLowerCase()
									const isRoundInsert = texName.includes('round') && !texName.includes('ground')
									const isInsertTex =
										texName.includes('insert') ||
										texName.includes('rect') ||
										isRoundInsert ||
										texName.includes('dot') ||
										texName.includes('triangle') ||
										texName.includes('flasher') ||
										texName.includes('vrlight')
									if (isInsertTex && m.transparent && m.opacity === 0) {
										m.transparent = false
										m.opacity = 1
										m.depthWrite = true
										m.alphaTest = 0
										m.blending = THREE.NormalBlending
										m.needsUpdate = true
									}
								}
							}
							fixed++
						}
					}
				})
				if (fixed) {
					let hasReadyBake = false
					this.tableGroup.traverse(o2 => {
						if (!o2.isMesh) return
						const n2 = o2.name || '',
							m2 = Array.isArray(o2.material) ? o2.material[0] : o2.material
						if (!m2?.map) return
						if (!n2.toLowerCase().includes('playfield') && !n2.toLowerCase().includes('bm_')) return
						const info = isBakedMeshByNames(
							n2,
							m2.name || '',
							m2.map?.name || '',
							!!m2.userData?.__isBaked,
							!!m2.userData?.__addBlend,
						)
						if (info.isBaked) hasReadyBake = true
					})
					if (hasReadyBake) {
						this.tableGroup.traverse(o2 => {
							if (!o2.isMesh || !o2.visible || !(o2.name || '').toLowerCase().includes('playfield'))
								return
							const m2 = Array.isArray(o2.material) ? o2.material[0] : o2.material
							if (!m2) return
							const info = isBakedMeshByNames(
								o2.name || '',
								m2.name || '',
								m2.map?.name || '',
								!!m2.userData?.__isBaked,
								!!m2.userData?.__addBlend,
							)
							if (!info.isBaked && !info.isMainBake && !info.isVlmBake) {
								o2.visible = false
								o2.geometry?.dispose?.()
							}
						})
					}
					this.tableGroup.traverse(o2 => {
						if (!o2.isMesh) return
						const n2 = (o2.name || '').toLowerCase()
						if (!n2.includes('playfield') && !n2.includes('bm_')) return
						const m2 = Array.isArray(o2.material) ? o2.material[0] : o2.material
						if (!m2?.map) return
						const isBaked = !!(m2.userData && m2.userData.__isBaked)
						const info2 = isBakedMeshByNames(
							n2,
							m2.name || '',
							m2.map?.name || '',
							!!m2.userData?.__isBaked,
							!!m2.userData?.__addBlend,
						)
						const shouldShow = isBaked || info2.isMainBake || (info2.isVlmBake && !info2.isMainBake)
						if (shouldShow && o2.visible === false) {
							o2.visible = true
							for (let p = o2.parent; p && p !== this.tableGroup; p = p.parent)
								if (p.visible === false) p.visible = true
						}
					})
				}
				return fixed
			}
			const schedulePatch = () => {
				if (scheduled) return
				scheduled = true
				queueMicrotask(() => {
					scheduled = false
					if (this._streamId !== streamId) return
					this.renderApi.getMaterialGenerator?.().resolvePendingTextures?.()
					patchCloned()
				})
			}
			const onTexture = (_tex, _ok) => {
				if (this._streamId !== streamId) return
				done++
				schedulePatch()
				if (done % 2 === 0 || done === total) this._setStreamProgress(done, total)
			}
			await this.renderApi.preloadTextures(textures, table, onTexture)
			if (this._streamId !== streamId) {
				if (reader) {
					await this._cleanupReader(reader)
				}
				return
			}
			const fixed = this.renderApi.getMaterialGenerator?.().resolvePendingTextures?.() ?? 0
			const fixed2 = patchCloned()
			if (fixed || fixed2)
				this.log(`[stream] Patched ${fixed + fixed2} materials (${fixed} cached + ${fixed2} cloned)`)
			if (this.tableGroup && table && this.renderApi) {
				const params = new URLSearchParams(location.search)
				if (!params.has('nobatched')) {
					const bakedRes = _batchStaticOpaques(this.tableGroup, table, this.renderApi)
					if (bakedRes) {
						this.log(`[batch] Post-stream baked ${bakedRes} BatchedMesh`, 'info')
						if (!isLowQuality()) buildBvhIdle(this.tableGroup)
						else this.log('[bvh] low quality: skip post-batch BVH', 'debug')
					} else {
						setTimeout(() => {
							if (this._disposed || !this.tableGroup) return
							const retry = _batchStaticOpaques(this.tableGroup, table, this.renderApi)
							if (retry) {
								this.log(`[batch] Post-stream retry baked ${retry} BatchedMesh`, 'info')
								if (!isLowQuality()) buildBvhIdle(this.tableGroup)
							}
						}, 600)
					}
				}
			}
			const tm = computeTexMem(this.tableGroup)
			this.log(
				`[stream] Done ${done}/${total} in ${(performance.now() - t0) | 0}ms — now ${tm.texCount} ~${tm.texMemMB} MB`,
			)
			this._setStreamProgress(total, total)
			if (this.dom.streamLabel) this.dom.streamLabel.textContent = 'Visuals ready'
			setTimeout(() => this._hideStream(), 1200)
			logMem(this.harnessLog, 'Stream ready')
			if (reader) {
				await this._cleanupReader(reader)
			}
			// generic: free raw texture binaries after streaming regardless of mode; keeps GPU textures only
			this._clearRawTextures?.()
			if (typeof (globalThis as any).gc === 'function') (globalThis as any).gc()
		})()
	}
	async _waitForPinmame(timeout = 45000) {
		if (!this._hasPinmame) return true
		this.log(`[wait] PinMAME wait up to ${timeout}ms — throttling render`)
		const start = performance.now()
		while (performance.now() - start < timeout) {
			const emu = this.player?.getPhysics?.()?.emu
			if (emu?.isMock) return true
			if (emu?.api?.isRunning?.() === 1) {
				this.log(`[wait] isRunning=1 after ${(performance.now() - start) | 0}ms`)
				return true
			}
			await new Promise(r => setTimeout(r, 200))
		}
		const emu = this.player?.getPhysics?.()?.emu
		this.log(`[wait] timeout ${timeout}ms isRunning=${emu?.api?.isRunning?.()} init=${emu?.isInitialized?.()}`)
		return false
	}
	async _fromReader(reader, source, _loadGen = this._loadId) {
		if (_loadGen !== this._loadId) {
			await this._cleanupReader(reader)
			return null
		}
		setTitle(
			typeof source === 'string'
				? source
						.split('/')
						.pop()
						?.replace(/\.vpx$/i, '')
				: '',
		)
		this._loading(62, 'Opening table…', 'Reading table data…')
		const table = await this._loadTable(reader)
		if (_loadGen !== this._loadId) {
			await this._cleanupReader(reader)
			return null
		}
		const { node, textures } = await this._buildScene(table)
		if (_loadGen !== this._loadId) {
			await this._cleanupReader(reader)
			return null
		}
		const mounted = await this._mount(table, node, {}, source)
		if (_loadGen !== this._loadId) {
			await this._cleanupReader(reader)
			return mounted
		}
		const streamIdle = () => {
			if (_loadGen !== this._loadId) {
				void this._cleanupReader(reader).catch(() => {})
				return
			}
			this._streamTextures(table, textures, reader)
		}
		if (typeof (globalThis as any).requestIdleCallback === 'function') {
			;(globalThis as any).requestIdleCallback(streamIdle, { timeout: 2000 })
		} else {
			setTimeout(streamIdle, 32)
		}
		return mounted
	}
	async load() {
		this._loadId = (this._loadId ?? 0) + 1
		const _loadGen = this._loadId
		if (this._loadAbort) this._loadAbort.abort()
		this._loadAbort = new AbortController()
		const _signal = this._loadAbort.signal
		this._streamId++
		await this._ensureRenderer()
		if (_loadGen !== this._loadId) return
		if (this.dom.loading) this.dom.loading.hidden = false
		if (this.dom.wrap) this.dom.wrap.hidden = false
		const _w = typeof window !== 'undefined' ? window.innerWidth : 800
		const _h = typeof window !== 'undefined' ? window.innerHeight : 600
		this.renderer?.setSize(_w, _h)
		this._loading(2, 'Getting ready…', 'Looking for table…')
		const candidates = resolveVpxCandidates({
			defaultName: this.defaultVpx,
			queryParam: this.queryParam,
		})
		if (!candidates.length) {
			this.log('No VPX candidate (pass ?vpx=name)', 'warn')
			return
		}
		this.log(`Trying ${candidates.join(', ')}`)
		for (const cand of candidates) {
			if (_loadGen !== this._loadId) return
			if (_signal.aborted) throw new DOMException('Aborted', 'AbortError')
			try {
				try {
					const { idbGet } = await import('../../dist-esm/lib/util/idb-cache.js')
					const cached = await idbGet(cand.split('/').pop())
					if (cached && cached.byteLength > 1_000_000) {
						this.log(`[IDB] hit ${cand.split('/').pop()} ${fmtBytes(cached.byteLength)} — using cached`)
						const reader = new BrowserBinaryReader(new Uint8Array(cached))
						await reader.open()
						if (_loadGen !== this._loadId) {
							try {
								await this._cleanupReader(reader)
							} catch {}
							return
						}
						const _res = await this._fromReader(reader, cand, _loadGen)
						if (_loadGen === this._loadId) this._loadAbort = null
						return _res
					}
				} catch {}
				if (_loadGen !== this._loadId) return
				if (_signal.aborted) throw new DOMException('Aborted', 'AbortError')
				this.log(`Fetching ${cand}…`)
				this._loading(5, 'Downloading…', 'Downloading table…')
				const t0 = performance.now()
				const vpxKey = cand.split('/').pop()
				const data = await fetchWithProgress(
					cand,
					p => {
						const pct = Math.round(p * 100)
						this._loading(5 + p * 60, `Downloading… ${pct}%`, `Downloading table… ${pct}%`)
					},
					{ signal: _signal },
				)
				this.log(`Fetched ${fmtBytes(data.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
				try {
					const { idbSet } = await import('../../dist-esm/lib/util/idb-cache.js')
					idbSet(vpxKey, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)).catch(
						() => {},
					)
				} catch {}
				if (_loadGen !== this._loadId) return
				const reader = new BrowserBinaryReader(data)
				await reader.open()
				if (_loadGen !== this._loadId) {
					try {
						await this._cleanupReader(reader)
					} catch {}
					return
				}
				const _res2 = await this._fromReader(reader, cand, _loadGen)
				if (_loadGen === this._loadId) this._loadAbort = null
				return _res2
			} catch (err) {
				if (_signal.aborted || err?.name === 'AbortError' || _loadGen !== this._loadId) return
				this.log(`Error loading ${cand}: ${err?.stack ?? err?.message}`, 'error')
			}
		}
		if (_loadGen !== this._loadId) return
		if (_loadGen === this._loadId) this._loadAbort = null
		throw new Error(`Failed: none of ${candidates.join(', ')}`)
	}
	async loadFromFile(file) {
		this._loadId = (this._loadId ?? 0) + 1
		const _loadGen = this._loadId
		if (this._loadAbort) this._loadAbort.abort()
		this._loadAbort = new AbortController()
		this._streamId++
		this._loading(5, 'Reading file…', `Reading ${file.name}…`)
		this.log(`Reading ${file.name}…`)
		const reader = new BrowserBinaryReader(file)
		await reader.open()
		if (_loadGen !== this._loadId) {
			await this._cleanupReader(reader)
			return null
		}
		const _res = await this._fromReader(reader, file.name, _loadGen)
		if (_loadGen === this._loadId) this._loadAbort = null
		return _res
	}
	async loadRomFile(file) {
		const buf = new Uint8Array(await file.arrayBuffer())
		window.__pendingRom = buf
		window.__pendingRomName = file.name.replace(/\.zip$/i, '')
		this.log(`ROM file ${file.name} ${fmtBytes(buf.length)} — stored`)
		return buf
	}
	async preloadRom(url) {
		this.log(`Preloading ROM ${url}…`)
		const data = await fetchWithProgress(url, p => this.setBar(5 + p * 40, `ROM ${(p * 100).toFixed(0)}%`), {
			signal: this._loadAbort?.signal,
		})
		window.__pendingRom = data
		window.__pendingRomName =
			url
				.split('/')
				.pop()
				?.replace(/\.zip$/i, '') || ''
		window.__pendingRomUrl = url
		this.log(`ROM preload OK ${fmtBytes(data.length)}`)
		return data
	}
	async startLoop() {
		await this._ensureRenderer()
		if (this._disposed || !this.renderer) return
		await this.precompilePipelines()
		if (this._disposed || !this.renderer) return
		if (this.animFrame) {
			cancelAnimationFrame(this.animFrame)
			clearTimeout(this.animFrame)
			this.animFrame = null
		}
		if (this._animRaf) {
			cancelAnimationFrame(this._animRaf)
			this._animRaf = null
		}
		if (this._animTimeout) {
			clearTimeout(this._animTimeout)
			this._animTimeout = null
		}
		if ((this as any)._physicsTimeout) {
			clearTimeout((this as any)._physicsTimeout)
			;(this as any)._physicsTimeout = null
		}
		let last = performance.now(),
			frames = 0,
			fps = 0
		let lastFpsUpdate = performance.now()
		let lastDmd = 0
		if (this.player && (!this._physicsSab || !this._physicsWorker)) {
			const res = this._createPhysicsWorker()
			if (res) this.log(`[physics] SAB ${res.sab.byteLength} worker started`, 'info')
		} else if (this._physicsSab) {
			this.log(`[physics] reusing SAB ${this._physicsSab.byteLength}`, 'debug')
		}
		// expose immediate physics tick for tests
		;(this as any)._tickPhysicsImmediate = () => {
			if (!this.player || this.isPaused || this.viewerMode !== 'play') return
			if (isLowQuality()) return
			if (this._physicsSab && this._physicsScratch) trySnap(this._physicsSab, this._physicsScratch)
			this.player.setPhysicsEnabled(true)
			this.player.updatePhysics()
			this.player.updateAnimations(this.player.getGameTime())
			const changed = this.player.popStates()
			if (!changed.isEmpty) {
				this.applyChangedStates(changed)
				if (!this._disposed) {
					if (this.renderPipeline) this.renderPipeline.render()
					else this.renderer.render(this.scene, this.camera)
				}
			} else changed.release()
		}
		this.renderer.setAnimationLoop((timestamp, frame) => {
			if (this._disposed || this.isPaused) return
			this._syncPhysicsTransforms(timestamp)
			if (this.controls?.enabled) this.controls.update()
			this._applyNudgeVisual()
			if (timestamp - lastDmd >= 32) {
				lastDmd = timestamp
				this._pollPinmame()
			}
			if (this.renderPipeline) this.renderPipeline.render()
			else this.renderer.render(this.scene, this.camera)
			frames++
			if (timestamp - lastFpsUpdate > 500) {
				fps = Math.round((frames * 1000) / (timestamp - lastFpsUpdate))
				lastFpsUpdate = timestamp
				frames = 0
				if (this.dom.stats) {
					const balls = this.player?.balls.length ?? 0
					const t = this.player?.getPhysics()?.timeMsec ?? 0
					const mode = this.viewerMode === 'play' ? (this.isPaused ? 'PLAY PAUSED' : 'PLAY') : 'VIEWER'
					const emu = this.player?.getPhysics()?.emu
					const emuRaw = emu ? emu.constructor.name : '—'
					const emuStat = !emu ? '' : emu.isInitialized?.() ? 'ok' : 'loading'
					const draws = this.renderer?.info?.render?.calls ?? 0
					const tris = this.renderer?.info?.render?.triangles ?? 0
					const trisFmt =
						tris >= 1e6
							? `${(tris / 1e6).toFixed(1)}M`
							: tris >= 1e3
								? `${(tris / 1e3).toFixed(1)}k`
								: `${tris}`
					const tFmt = t ? `${(t / 1000).toFixed(1)}s` : '—'
					const emuLabel = emuStat ? `${emuRaw} · ${emuStat}` : emuRaw
					const wasmReady = isWasmReady()
					const wasmLabel = wasmReady ? 'Ready' : 'Loading…'
					renderStats(this.dom.stats, {
						fps,
						draws,
						trisFmt,
						balls,
						tFmt,
						tHasValue: !!t,
						emuLabel,
						emuRaw,
						wasmLabel,
						wasmReady,
						backend: this._rendererBackend,
						mode,
					})
				}
				const hud = this.dom.fpsHud || document.getElementById('fps-hud')
				if (hud) {
					let el = hud.querySelector('.fps')
					if (!el) {
						el = document.createElement('span')
						el.className = 'fps'
						hud.textContent = ''
						hud.append(el)
					}
					el.textContent = `${fps} fps`
					const cls = fps >= 55 ? 'fps--good' : fps >= 30 ? 'fps--mid' : fps > 0 ? 'fps--low' : ''
					el.className = `fps ${cls}`.trim()
				}
			}
		})
	}

	render() {
		if (this.renderPipeline) this.renderPipeline.render()
		else this.renderer?.render(this.scene, this.camera)
	}

	_updateStatsOverlay(fps) {
		if (!this.dom.stats) return
	}

	_pollPinmame() {
		if (!this._emuStartLogged) {
			const emu = this.player?.getPhysics()?.emu
			if (emu) {
				this._emuStartLogged = true
				this.log(`PinMAME emu started: ${emu.constructor.name} ${emu.getVersion?.() ?? ''}`)
			}
		}
		this.dmd.render()
	}
	_applyNudgeVisual() {
		if (!this.tableGroup || !this.player || this.viewerMode !== 'play') return
		const phys = this.player.getPhysics?.()
		if (!phys) return
		if (!this._tableBasePos) {
			this._tableBasePos = this.tableGroup.position.clone()
		}
		const base = this._tableBasePos
		const off = phys.getCabinetOffset?.()
		const acc = phys.getCabinetAcceleration?.()
		const hasOff = off && (Math.abs(off.x) > 1e-4 || Math.abs(off.y) > 1e-4)
		const hasAcc = acc && (Math.abs(acc.x) > 1e-3 || Math.abs(acc.y) > 1e-3)
		if (!hasOff && !hasAcc) {
			if (this.tableGroup.userData._nudgeApplied) {
				this.tableGroup.position.x += (base.x - this.tableGroup.position.x) * 0.15
				this.tableGroup.position.y += (base.y - this.tableGroup.position.y) * 0.15
				if (Math.hypot(this.tableGroup.position.x - base.x, this.tableGroup.position.y - base.y) < 0.01) {
					this.tableGroup.position.x = base.x
					this.tableGroup.position.y = base.y
					this.tableGroup.userData._nudgeApplied = false
				}
			}
			const wrap = this.dom.wrap
			if (wrap) {
				wrap.classList.remove('is-nudging')
				wrap.style.removeProperty('--nudge-transform')
			}
			return
		}
		const ampOff = 110
		const ampAcc = 0.22
		const tx = (off?.x ?? 0) * ampOff + (acc?.x ?? 0) * ampAcc
		const ty = (off?.y ?? 0) * ampOff + (acc?.y ?? 0) * ampAcc
		const scaleX = Math.max(-6, Math.min(6, tx))
		const scaleY = Math.max(-6, Math.min(6, -ty * 0.6))
		this.tableGroup.position.x = base.x + scaleX
		this.tableGroup.position.y = base.y + scaleY
		this.tableGroup.userData._nudgeApplied = true
		const wrap = this.dom.wrap
		if (wrap) {
			const shake = Math.hypot(scaleX, scaleY)
			if (shake > 0.05) {
				wrap.style.setProperty('--nudge-transform', `translate(${scaleX * 0.6}px, ${scaleY * 0.6}px)`)
				wrap.classList.add('is-nudging')
			} else {
				wrap.classList.remove('is-nudging')
				wrap.style.removeProperty('--nudge-transform')
			}
		}
	}
	_nudge(angle, force = 2.6) {
		if (!this.player || this.viewerMode !== 'play' || this.isPaused) return
		this.player.nudge(angle, force)
		this._flashNudge(angle)
	}
	_sendKey(code, down) {
		const keyForCode = c =>
			c === 'Enter'
				? 'Enter'
				: c.startsWith('Digit')
					? c.slice(5)
					: c.startsWith('Key')
						? c.slice(3).toLowerCase()
						: c.startsWith('Shift')
							? 'Shift'
							: c.startsWith('Control')
								? 'Control'
								: c.startsWith('Alt')
									? 'Alt'
									: c === 'Space'
										? ' '
										: c
		const locationForCode = c => (c.endsWith('Left') ? 1 : c.endsWith('Right') ? 2 : undefined)
		const key = keyForCode(code)
		const location = locationForCode(code)
		const ev = { code, key, location, ts: Date.now() }
		if (down) this.player.onKeyDown(ev)
		else this.player.onKeyUp(ev)
		if (this._physicsSab) {
			const dik = keyEventToDirectInputKey(ev as any)
			if (dik) pushInput(this._physicsSab, down ? 1 : 0, dik, Date.now())
		}
	}
	_flashNudge(angle) {
		const el = this.dom.nudgeFlash
		if (!el || this.viewerMode !== 'play') return
		const dir =
			angle >= 45 && angle < 135
				? 'left'
				: angle >= 135 && angle < 225
					? 'down'
					: angle >= 225 && angle < 315
						? 'right'
						: 'up'
		el.textContent = dir === 'left' ? '‹ NUDGE' : dir === 'right' ? 'NUDGE ›' : dir === 'up' ? '▲ NUDGE' : '▼ NUDGE'
		el.dataset.dir = dir
		el.hidden = false
		el.classList.remove('show')
		void el.offsetWidth
		el.classList.add('show')
		clearTimeout(this._nudgeFlashTimer)
		this._nudgeFlashTimer = setTimeout(() => {
			el.classList.remove('show')
			el.hidden = true
		}, 420)
	}
	hookInput() {
		if (!this.player) return
		this._inputCleanup?.()
		this._inputCleanup = attachInput(this)
		if (this.dom.canvas) {
			this.dom.canvas.tabIndex = 0
			setTimeout(() => {
				this.dom.canvas.focus()
			}, 50)
			setTimeout(() => {
				this.dom.canvas.focus()
			}, 300)
		}
	}
}
export function createViewer(opts) {
	return new Viewer(opts)
}
