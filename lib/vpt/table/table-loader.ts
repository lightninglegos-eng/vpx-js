// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import { type IBinaryReader, OleCompoundDoc, type Storage } from '../../io/ole-doc.js'
import { logger, progress } from '../../util/logger.js'
import { Collection } from '../collection/collection.js'
import type { Item } from '../item.js'
import type { ItemData } from '../item-data.js'
import { ITEM_KEYS, ITEM_REGISTRY, loadItemByType } from '../item-registry.js'
import { Sound } from '../sound.js'
import { Texture } from '../texture.js'
import type { TableLoadOptions } from './table.js'
import { TableData } from './table-data.js'

const decoder = new TextDecoder()

// Yield every N entries during bulk OLE parsing so large tables (1000+ items) don't block the UI.
// Uses scheduler.yield() when available, otherwise setTimeout.
const YIELD_EVERY_GAME_ITEMS = 32
const YIELD_EVERY_TEXTURES = 16
const YIELD_EVERY_SOUNDS = 16
const YIELD_EVERY_COLLECTIONS = 16

const MAX_CONCURRENCY_GAME_ITEMS = 4
const MAX_CONCURRENCY_TEXTURES = 6
const MAX_CONCURRENCY_SOUNDS = 6
const MAX_CONCURRENCY_COLLECTIONS = 4

function hardwareConcurrency(): number {
	return (
		(globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4
	)
}

/** Loads VPX OLE storage into table model. */
export class TableLoader {
	private doc!: OleCompoundDoc
	private _lock: Promise<void> = Promise.resolve()

	public async load(reader: IBinaryReader, opts: TableLoadOptions = {}): Promise<LoadedTable> {
		progress().start('table.load', 'Loading VPX file')
		const t0 = Date.now()
		this.doc = await OleCompoundDoc.load(reader)
		try {
			const out: LoadedTable = { items: {} }
			if (opts.loadTableScript || opts.tableDataOnly || !opts.tableInfoOnly) {
				const gameStg = this.doc.storage('GameStg')
				out.data = await TableData.fromStorage(gameStg, 'GameData')
				if (!opts.tableDataOnly) {
					await this.loadGameItems(out, gameStg, out.data.numGameItems, opts)
					if (!opts.skipTextures) await this.loadTextures(out, gameStg, out.data.numTextures)
					else {
						out.textures = []
						logger().debug('[Table.load] Skipped %s textures (play without textures)', out.data.numTextures)
					}
					await this.loadSounds(out, gameStg, out.data.numSounds)
					await this.loadCollections(out, gameStg, out.data.numCollections)
				}
				if (opts.loadTableScript) {
					const script = await gameStg.read('GameData', out.data.scriptPos, out.data.scriptLen)
					out.tableScript = decoder.decode(script)
					if (out.tableScript.endsWith('ENDB')) out.tableScript = out.tableScript.slice(0, -8)
				}
			}
			if (opts.tableInfoOnly || !opts.tableDataOnly) await this.loadTableInfo(out)
			logger().info('[Table.load] Table loaded in %sms.', Date.now() - t0)
			return out
		} finally {
			await this.doc.close()
			progress().end('table.load')
		}
	}

	public async streamStorage<T>(name: string, streamer: (stg: Storage) => Promise<T>): Promise<T> {
		// Browser reader retains buffer after close, so bypass lock/reopen for concurrency.
		const readerData = (this.doc as unknown as { reader?: { data?: Uint8Array } }).reader?.data
		if (readerData) {
			return await streamer(this.doc.storage(name))
		}
		let release!: () => void
		const prev = this._lock
		this._lock = new Promise<void>(r => (release = r))
		await prev
		try {
			await this.doc.reopen()
			return await streamer(this.doc.storage(name))
		} finally {
			await this.doc.close()
			release()
		}
	}

	private async loadGameItems(
		out: LoadedTable,
		storage: Storage,
		numItems: number,
		opts: TableLoadOptions,
	): Promise<void> {
		for (const key of ITEM_KEYS) (out as unknown as Record<string, unknown>)[key] = []
		progress().show('Loading game items')
		if (numItems === 0) return
		const concurrency = Math.min(MAX_CONCURRENCY_GAME_ITEMS, hardwareConcurrency())
		const results: Array<Item<ItemData> | null> = new Array(numItems)
		const types = new Int32Array(numItems)
		let next = 0
		const workers = Array.from({ length: Math.min(concurrency, numItems) }, async () => {
			while (true) {
				const i = next++
				if (i >= numItems) break
				const name = `GameItem${i}`
				const data = await storage.read(name, 0, 4)
				const type = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(0, true)
				types[i] = type
				results[i] = await loadItemByType(storage, name, type, opts)
				if ((i + 1) % YIELD_EVERY_GAME_ITEMS === 0) await this.yield()
			}
		})
		await Promise.all(workers)
		for (let i = 0; i < numItems; i++) {
			const item = results[i]
			if (!item) continue
			const type = types[i]!
			const key = ITEM_REGISTRY[type]?.key
			if (key && ((key !== 'textBoxes' && key !== 'timers') || opts.loadInvisibleItems)) {
				;((out as unknown as Record<string, Item<ItemData>[] | undefined>)[key] ??= []).push(item)
			}
			out.items[item.getName()] = item
			progress().details(item.getName())
		}
	}

	private async loadTextures(out: LoadedTable, storage: Storage, numItems: number): Promise<void> {
		progress().show('Loading textures')
		out.textures = []
		if (numItems === 0) return
		const concurrency = Math.min(MAX_CONCURRENCY_TEXTURES, hardwareConcurrency())
		const results: Texture[] = new Array(numItems)
		let next = 0
		const workers = Array.from({ length: Math.min(concurrency, numItems) }, async () => {
			while (true) {
				const i = next++
				if (i >= numItems) break
				results[i] = await Texture.fromStorage(storage, `Image${i}`)
				if ((i + 1) % YIELD_EVERY_TEXTURES === 0) await this.yield()
			}
		})
		await Promise.all(workers)
		for (let i = 0; i < numItems; i++) {
			const tex = results[i]!
			out.textures.push(tex)
			progress().details(tex.getName())
		}
	}

	private async loadSounds(out: LoadedTable, storage: Storage, numItems: number): Promise<void> {
		progress().show('Loading sounds')
		out.sounds = []
		if (numItems === 0) return
		const concurrency = Math.min(MAX_CONCURRENCY_SOUNDS, hardwareConcurrency())
		const results: Sound[] = new Array(numItems)
		let next = 0
		const workers = Array.from({ length: Math.min(concurrency, numItems) }, async () => {
			while (true) {
				const i = next++
				if (i >= numItems) break
				results[i] = await Sound.fromStorage(storage, `Sound${i}`)
				if ((i + 1) % YIELD_EVERY_SOUNDS === 0) await this.yield()
			}
		})
		await Promise.all(workers)
		for (let i = 0; i < numItems; i++) {
			const snd = results[i]!
			out.sounds.push(snd)
			progress().details(snd.getName())
		}
	}

	private async loadTableInfo(out: LoadedTable): Promise<void> {
		const stg = this.doc.storage('TableInfo')
		out.info = {}
		for (const key of stg.getStreams()) {
			const data = await stg.read(key)
			if (data) out.info[key] = decoder.decode(data).replace(/\0/g, '')
		}
	}

	private async loadCollections(out: LoadedTable, storage: Storage, numItems: number): Promise<void> {
		out.collections = []
		if (numItems === 0) return
		const concurrency = Math.min(MAX_CONCURRENCY_COLLECTIONS, hardwareConcurrency())
		const results: Collection[] = new Array(numItems)
		let next = 0
		const workers = Array.from({ length: Math.min(concurrency, numItems) }, async () => {
			while (true) {
				const i = next++
				if (i >= numItems) break
				results[i] = await Collection.fromStorage(storage, `Collection${i}`)
				if ((i + 1) % YIELD_EVERY_COLLECTIONS === 0) await this.yield()
			}
		})
		await Promise.all(workers)
		for (let i = 0; i < numItems; i++) {
			const col = results[i]!
			out.collections.push(col)
			out.items[col.getName()] = col
		}
	}

	private async yield(): Promise<void> {
		const g = globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }
		if (g.scheduler?.yield) await g.scheduler.yield()
		else await new Promise<void>(r => setTimeout(r, 0))
	}
}

export interface LoadedTable {
	data?: TableData
	info?: Record<string, string>
	items: Record<string, Item<ItemData>>
	tableScript?: string
	textures?: Texture[]
	sounds?: Sound[]
	collections?: Collection[]
	surfaces?: import('../surface/surface.js').Surface[]
	primitives?: import('../primitive/primitive.js').Primitive[]
	rubbers?: import('../rubber/rubber.js').Rubber[]
	flippers?: import('../flipper/flipper.js').Flipper[]
	flashers?: import('../flasher/flasher.js').Flasher[]
	bumpers?: import('../bumper/bumper.js').Bumper[]
	ramps?: import('../ramp/ramp.js').Ramp[]
	lights?: import('../light/light.js').Light[]
	hitTargets?: import('../hit-target/hit-target.js').HitTarget[]
	gates?: import('../gate/gate.js').Gate[]
	kickers?: import('../kicker/kicker.js').Kicker[]
	triggers?: import('../trigger/trigger.js').Trigger[]
	spinners?: import('../spinner/spinner.js').Spinner[]
	plungers?: import('../plunger/plunger.js').Plunger[]
	textBoxes?: import('../textbox/textbox.js').Textbox[]
	decals?: import('../decal/decal.js').Decal[]
	lightSeqs?: import('../lightseq/lightseq.js').LightSeq[]
	dispReels?: import('../dispreel/dispreel.js').DispReel[]
	timers?: import('../timer/timer.js').Timer[]
}
