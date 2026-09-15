// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE
import { MathUtils } from 'three'

import { Event } from '../../game/event.js'
import { EventProxy } from '../../game/event-proxy.js'
import { type IAnimatable, isAnimatable } from '../../game/ianimatable.js'
import { type IHittable, isHittable } from '../../game/ihittable.js'
import { type IMovable, isMovable } from '../../game/imovable.js'
import { type IPlayable, isPlayable } from '../../game/iplayable.js'
import { type IRenderable, isRenderable, type Meshes } from '../../game/irenderable.js'
import { type IScriptable, isScriptable } from '../../game/iscriptable.js'
import type { Player } from '../../game/player.js'
import type { IBinaryReader, Storage } from '../../io/ole-doc.js'
import type { HitObject } from '../../physics/hit-object.js'
import { HitPlane } from '../../physics/hit-plane.js'
import type { IRenderApi } from '../../render/irender-api.js'
import { Transpiler } from '../../scripting/transpiler.js'
import { FRect3D } from '../../util/frect3d.js'
import { logger, progress } from '../../util/logger.js'
import { Vertex3D } from '../../util/vector.js'
import type { Bumper } from '../bumper/bumper.js'
import type { Collection } from '../collection/collection.js'
import type { Decal } from '../decal/decal.js'
import type { DispReel } from '../dispreel/dispreel.js'
import type { Flasher } from '../flasher/flasher.js'
import type { Flipper } from '../flipper/flipper.js'
import type { Gate } from '../gate/gate.js'
import type { HitTarget } from '../hit-target/hit-target.js'
import type { Item } from '../item.js'
import type { ItemApi } from '../item-api.js'
import type { ItemData } from '../item-data.js'
import { ITEM_REGISTRY } from '../item-registry.js'
import type { ItemState } from '../item-state.js'
import type { Kicker } from '../kicker/kicker.js'
import type { Light } from '../light/light.js'
import type { LightSeq } from '../lightseq/lightseq.js'
import type { Material } from '../material.js'
import type { Plunger } from '../plunger/plunger.js'
import type { Primitive } from '../primitive/primitive.js'
import type { Ramp } from '../ramp/ramp.js'
import type { Rubber } from '../rubber/rubber.js'
import type { Spinner } from '../spinner/spinner.js'
import type { Surface } from '../surface/surface.js'
import type { Textbox } from '../textbox/textbox.js'
import type { Texture } from '../texture.js'
import type { Timer } from '../timer/timer.js'
import type { Trigger } from '../trigger/trigger.js'
import { TableApi } from './table-api.js'
import type { TableData } from './table-data.js'
import type { TableExportOptions } from './table-exporter.js'
import { TableHitGenerator } from './table-hit-generator.js'
import { type LoadedTable, TableLoader } from './table-loader.js'
import { TableMeshGenerator } from './table-mesh-generator.js'
import { TableState } from './table-state.js'
import { TableUpdater } from './table-updater.js'

/** Visual Pinball table — holds all elements of a .vpx file.
 * @see https://github.com/vpinball/vpinball/blob/master/pintable.cpp */
export class Table implements IScriptable<TableApi>, IRenderable<TableState> {
	public readonly data?: TableData
	public readonly info?: { [key: string]: string }
	public readonly items: Record<string, Item<ItemData>>
	public readonly tableScript?: string
	private readonly state?: TableState
	private readonly updater?: TableUpdater
	private events?: EventProxy
	private api?: TableApi
	private itemIndex?: Record<string, string>

	public readonly textures: Record<string, Texture> = {}
	public readonly collections: Record<string, Collection> = {}
	public readonly bumpers: Record<string, Bumper> = {}
	public readonly flippers: Record<string, Flipper> = {}
	public readonly flashers: Record<string, Flasher> = {}
	public readonly gates: Record<string, Gate> = {}
	public readonly hitTargets: Record<string, HitTarget> = {}
	public readonly kickers: Record<string, Kicker> = {}
	public readonly lights: Record<string, Light> = {}
	public readonly plungers: Record<string, Plunger> = {}
	public readonly primitives: Record<string, Primitive> = {}
	public readonly ramps: Record<string, Ramp> = {}
	public readonly rubbers: Record<string, Rubber> = {}
	public readonly spinners: Record<string, Spinner> = {}
	public readonly surfaces: Record<string, Surface> = {}
	public readonly textboxes: Record<string, Textbox> = {}
	public readonly timers: Record<string, Timer> = {}
	public readonly triggers: Record<string, Trigger> = {}
	public readonly decals: Record<string, Decal> = {}
	public readonly lightSeqs: Record<string, LightSeq> = {}
	public readonly dispReels: Record<string, DispReel> = {}

	private readonly meshGenerator?: TableMeshGenerator
	private readonly hitGenerator?: TableHitGenerator

	public static playfieldThickness = 20.0

	public static async load(reader: IBinaryReader, opts: TableLoadOptions = defaultTableLoadOptions): Promise<Table> {
		const merged = { ...defaultTableLoadOptions, ...opts }
		const l = new TableLoader()
		return new Table(l, await l.load(reader, merged))
	}

	constructor(
		private readonly loader: TableLoader,
		loaded: LoadedTable,
	) {
		this.items = loaded.items
		if (loaded.data) {
			this.data = loaded.data
			this.meshGenerator = new TableMeshGenerator(this)
			this.hitGenerator = new TableHitGenerator(loaded.data)
			this.state = TableState.claim(this.data.getName(), this.data.szPlayfieldMaterial, true)
			this.updater = new TableUpdater(this.state)
		}
		if (loaded.info) this.info = loaded.info
		if (loaded.tableScript) this.tableScript = loaded.tableScript
		this.populateFromLoaded(
			loaded as unknown as Record<string, unknown>,
			'textures',
			this.textures as unknown as Record<string, unknown>,
		)
		this.populateFromLoaded(
			loaded as unknown as Record<string, unknown>,
			'collections',
			this.collections as unknown as Record<string, unknown>,
		)
		for (const [_type, entry] of Object.entries(ITEM_REGISTRY)) {
			const loadedKey = entry.key as keyof typeof loaded
			const tableKey = loadedKey === 'textBoxes' ? 'textboxes' : loadedKey
			this.populateFromLoaded(
				loaded as unknown as Record<string, unknown>,
				loadedKey as unknown as string,
				(this as unknown as Record<string, unknown>)[tableKey] as Record<string, unknown>,
			)
		}
		this.fixFlipperBats()
	}

	private fixFlipperBats(): void {
		const PROXIMITY = 15
		const TOLERANCE = 0.6
		const flippers = Object.values(this.flippers)
		if (!flippers.length) return
		for (const prim of Object.values(this.primitives)) {
			const d = prim.data.rotAndTra
			if (prim.data.staticRendering) continue
			if (d[2] !== 0 || !d[8] || d[0] !== 0 || d[1] !== 0) continue
			for (const f of flippers) {
				const c = f.data.center
				if (Math.hypot(prim.data.position.x - c.x, prim.data.position.y - c.y) > PROXIMITY) continue
				const angle = d[8] as number
				if (Math.abs(angle - f.data.startAngle) > TOLERANCE) continue
				// Bat stored in ObjRotZ but driven via RotZ → double without remap.
				d[8] = 0
				d[2] = angle
				const s = prim.getState()
				s.objectRotation.z = 0
				s.rotation.z = angle
				break
			}
		}
	}

	private populateFromLoaded(loaded: Record<string, unknown>, key: string, dict: Record<string, unknown>): void {
		const items = loaded[key] as unknown as { getName(): string }[] | undefined
		if (!items?.length) return
		for (const it of items) dict[it.getName()] = it
	}

	public getName(): string {
		return this.data?.getName()
	}
	public getTexture(name?: string): Texture | undefined {
		return name ? this.textures[name.toLowerCase()] : undefined
	}
	public getMaterial(name?: string): Material | undefined {
		// a script can assign an unresolved/Empty VBScript value here (e.g. an array slot
		// that was never populated) - real VBScript coerces Empty to "" harmlessly, so treat
		// any non-string the same as "no material" rather than crashing on it
		if (typeof name !== 'string' || !name || !this.data) return undefined
		const mats = this.data.materials
		const lc = name.toLowerCase()
		return (
			mats.find(m => m.name === name) ??
			mats.find(m => m.name.toLowerCase() === lc) ??
			mats.find(m => m.name.toLowerCase() === `_${lc}`) ??
			(name.startsWith('_') ? mats.find(m => m.name.toLowerCase() === lc.slice(1)) : undefined)
		)
	}
	public getApi(): TableApi {
		return this.api!
	}
	public getState(): TableState {
		return this.state!
	}
	public getUpdater(): TableUpdater {
		return this.updater!
	}
	public getEventNames(): string[] {
		return ['Exit', 'Init', 'KeyDown', 'KeyUp', 'MusicDone', 'Paused', 'UnPaused']
	}

	public setupPlayer(player: Player, _table: Table): void {
		this.events = new EventProxy(this)
		this.api = new TableApi(this.data!, this.events, player, this)
	}

	public getBoundingBox(): FRect3D {
		return new FRect3D(
			this.data?.left,
			this.data?.right,
			this.data?.top,
			this.data?.bottom,
			this.getTableHeight(),
			this.data?.glassHeight,
		)
	}

	public getPlayables(): IPlayable[] {
		return [this, ...this.filterItems(isPlayable)]
	}
	public getMovables(): IMovable[] {
		return this.filterItems(isMovable)
	}
	public getRenderables(): Array<IRenderable<ItemState>> {
		return this.filterItems(isRenderable)
	}
	public getAnimatables(): IAnimatable[] {
		return this.filterItems(isAnimatable)
	}
	public getScriptables(): Array<IScriptable<ItemApi<ItemData>>> {
		return [this, ...this.filterItems(isScriptable)]
	}
	public getHittables(): IHittable[] {
		return this.filterItems(isHittable)
	}

	private filterItems<T>(guard: (x: unknown) => x is T): T[] {
		return this.getItems().filter(guard) as unknown as T[]
	}
	public getHitShapes(): HitObject[] {
		return this.hitGenerator?.generateHitObjects()
	}

	public generatePlayfieldHit(): HitPlane {
		return new HitPlane(new Vertex3D(0, 0, 1), this.data?.tableHeight ?? 0)
			.setFriction(this.data?.getFriction())
			.setElasticity(this.data?.getElasticity(), this.data?.getElasticityFalloff())
			.setScatter(MathUtils.degToRad(this.data?.getScatter()))
	}
	public generateGlassHit(): HitPlane {
		return new HitPlane(new Vertex3D(0, 0, -1), this.data?.glassHeight ?? 0).setElasticity(0.2)
	}

	public getElementApis(): Record<string, ItemApi<ItemData>> {
		const apis: Record<string, ItemApi<ItemData>> = {}
		for (const el of this.getScriptables()) apis[el.getName()] = el.getApi()
		return apis
	}

	public getElementApiName(vbsName: string): string {
		if (!this.itemIndex) {
			this.itemIndex = {}
			for (const el of this.getScriptables()) this.itemIndex[el.getName().toLowerCase()] = el.getName()
		}
		return this.itemIndex[vbsName.toLowerCase()]!
	}

	public getElements(): Record<string, IScriptable<ItemApi<ItemData>>> {
		const els: Record<string, IScriptable<ItemApi<ItemData>>> = {}
		for (const el of this.getScriptables()) els[el.getName()] = el
		return els
	}

	public getScaleZ(): number {
		if (!this.data) throw new Error('Table data not loaded')
		return this.data.bgScaleZ[this.data.bgCurrentSet]! || 1.0
	}
	public getDetailLevel(): number {
		return 10
	}
	public getGlobalDifficulty(): number {
		return this.data?.globalDifficulty ?? 0.2
	}
	private get baseHeight(): number {
		if (!this.data) throw new Error('Table data not loaded')
		return this.data.tableHeight ?? 0
	}

	public getTableHeight(): number {
		return this.baseHeight
	}

	public getDimensions(): { width: number; height: number } {
		if (!this.data) throw new Error('Table data not loaded')
		return { width: this.data.right - this.data.left, height: this.data.bottom - this.data.top }
	}

	public getPlayfieldMap(): string {
		if (!this.data) throw new Error('Table data not loaded')
		return this.data.szImage || ''
	}

	public getSurfaceHeight(surface: string | undefined, x: number, y: number): number {
		if (!this.data) throw new Error('Table data not loaded')
		const base = this.baseHeight
		if (!surface) return base
		const s = this.surfaces[surface]
		if (s) return base + s.heightTop
		const r = this.ramps[surface]
		if (r) return base + r.getSurfaceHeight(x, y, this)
		logger().warn('[Table.getSurfaceHeight] Unknown surface %s.', surface)
		return base
	}

	public async streamStorage<T>(name: string, streamer: (stg: Storage) => Promise<T>): Promise<T> {
		return this.loader.streamStorage(name, streamer)
	}

	public getTableScript(): string {
		if (!this.tableScript) throw new Error('Table script not loaded')
		return this.tableScript
	}
	public isVisible(): boolean {
		return true
	}

	public getMeshes<NODE, GEOMETRY, POINT_LIGHT>(
		_table: Table,
		renderApi: IRenderApi<NODE, GEOMETRY, POINT_LIGHT>,
		opts: TableExportOptions,
	): Meshes<GEOMETRY> {
		if (!this.data) throw new Error('Table data not loaded')
		return {
			playfield: {
				isVisible: true,
				geometry: this.meshGenerator?.getPlayfieldMesh(renderApi, opts),
				material: this.getMaterial(this.data.szPlayfieldMaterial),
				map: this.getTexture(this.data.szImage),
			},
		}
	}

	/** Generates top-most scene node containing the entire table. */
	public async generateTableNode<NODE, GEOMETRY, POINT_LIGHT>(
		renderApi: IRenderApi<NODE, GEOMETRY, POINT_LIGHT>,
		opts: TableExportOptions & { preloadTextures?: boolean } = {},
	): Promise<NODE> {
		if (opts.preloadTextures !== false) {
			await renderApi.preloadTextures(Object.values(this.textures), this)
		}
		return (await this.meshGenerator?.generateTableNode(renderApi, opts)) as NODE
	}

	public prepareToPlay(): void {
		for (const p of Object.values<Primitive>(this.primitives)) p.clearMesh()
	}

	public runTableScript(player: Player, scope: Record<string, unknown> = {}): void {
		if (!this.tableScript) {
			logger().warn('Table script not loaded!')
			return
		}
		progress().show('Transpiling and executing table script')
		const started = Date.now()
		new Transpiler(this, player).execute(this.tableScript, scope)
		logger().info('Table script transpiled and executed in %sms.', Date.now() - started)
	}

	public async runTableScriptAsync(player: Player, scope: Record<string, unknown> = {}): Promise<void> {
		if (!this.tableScript) {
			logger().warn('Table script not loaded!')
			return
		}
		progress().show('Transpiling and executing table script')
		const started = Date.now()
		await new Transpiler(this, player).executeAsync(this.tableScript, scope)
		logger().info('Table script transpiled and executed in %sms.', Date.now() - started)
	}

	public broadcastInit(): void {
		this.events?.fireVoidEvent(Event.GameEventsInit)
		for (const item of Object.values(this.items)) {
			const proxy = (item as unknown as { getEventProxy?: () => EventProxy })?.getEventProxy?.()
			proxy?.fireVoidEvent(Event.GameEventsInit)
		}
	}
	public fireVoidEvent(event: Event): this {
		this.events?.fireVoidEvent(event)
		return this
	}

	public setupCollections(): void {
		for (const item of Object.values(this.items))
			if (isScriptable(item as unknown))
				(item as unknown as IScriptable<ItemApi<ItemData>>).getApi()._resetCollections()
		for (const col of Object.values(this.collections))
			for (const name of col.getItemNames()) {
				const item = this.items[name]
				if (!item) {
					logger().warn('Non-existent item "%s" in collection "%s", skipping.', name, col.getName())
					break
				}
				if (isScriptable(item as unknown)) {
					;(item as unknown as IScriptable<ItemApi<ItemData>>).getApi()._addCollection(col, col.items.length)
					col.items.push((item as unknown as IScriptable<ItemApi<ItemData>>).getApi())
				}
			}
	}

	public getItems(): Array<Item<ItemData>> {
		return Object.values(this.items)
	}
}

const defaultTableLoadOptions: TableLoadOptions = {
	tableDataOnly: false,
	tableInfoOnly: false,
	loadInvisibleItems: true,
	loadTableScript: true,
}

/** Options for loading a table. */
export interface TableLoadOptions {
	/** Only parse game data, skip items (faster). */
	tableDataOnly?: boolean
	/** Only parse table info, skip storage. */
	tableInfoOnly?: boolean
	/** Also parse invisible items (timers, etc.). */
	loadInvisibleItems?: boolean
	/** Read table script. */
	loadTableScript?: boolean
	/** Skip primitive mesh data. */
	skipMeshes?: boolean
	/** Skip texture images (faster, for play without textures). */
	skipTextures?: boolean
}

/** Mesh generation options. */
export interface TableGenerateOptions {
	exportPlayfield?: boolean
	exportPrimitives?: boolean
	exportRubbers?: boolean
	exportSurfaces?: boolean
	exportFlippers?: boolean
	exportBumpers?: boolean
	exportRamps?: boolean
	exportLightBulbs?: boolean
	exportPlayfieldLights?: boolean
	exportLightBulbLights?: boolean
	exportHitTargets?: boolean
	exportGates?: boolean
	exportKickers?: boolean
	exportTriggers?: boolean
	exportSpinners?: boolean
	exportPlungers?: boolean
	gltfOptions?: TableGenerateGltfOptions
}

export interface TableGenerateGltfOptions {
	binary?: boolean
	trs?: boolean
	onlyVisible?: boolean
	animations?: any[]
	maxTextureSize?: number
	includeCustomExtensions?: boolean
}
