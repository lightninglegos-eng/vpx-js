// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import wpcEmuPkg from 'wpc-emu'

const GamelistDB = (wpcEmuPkg as any)?.GamelistDB ?? (wpcEmuPkg as any)?.default?.GamelistDB ?? wpcEmuPkg

import { PinMameEmulator } from '../../emu/pinmame/pinmame-emu.js'
import { downloadGameEntry } from '../../emu/rom-fetcher.js'
import { Emulator } from '../../emu/wpc-emu.js'
import type { IEmulator } from '../../game/iemulator.js'
import type { Player } from '../../game/player.js'
import { logger } from '../../util/logger.js'
import type { VbsArray } from '../vbs-array.js'

export class VpmController {
	private static readonly FLIPTRONICS: Record<number, string> = { 112: 'F2', 114: 'F4', 116: 'F6', 118: 'F8' }

	private emulator: IEmulator = new Emulator()
	private gameName = ''
	private splashInfoLine = ''
	private timeFence = 0
	private loadPromise: Promise<void> | null = null
	private readonly gameSettings = new Map<string, { Settings: { Value: Record<string, unknown> } }>()
	private readonly solMaskCache = new Map<number, number>()
	private readonly dipCache = new Map<number, number>()
	private readonly switchCache = new Map<number, boolean>()

	readonly Switch: Record<number, number>
	readonly Dip: Record<number, number>
	readonly SolMask: Record<number, number>
	readonly Lamp: Record<number, number>
	readonly Solenoid: Record<number, number>
	readonly GIString: Record<number, number>
	readonly Games: any
	readonly Mech: Record<number, number>
	readonly GetMech: Record<number, number>

	constructor(private readonly player: Player) {
		this.Switch = this.boolProxy(
			i => {
				const cached = this.switchCache.get(i)
				return cached !== undefined ? (cached ? 1 : 0) : this.emulator.getSwitchInput(i)
			},
			(n, v) => {
				if (v === true) this.switchCache.set(n, true)
				else if (v === false) this.switchCache.set(n, false)
				else if (v === undefined) this.switchCache.delete(n)
				const f = VpmController.FLIPTRONICS[n]
				if (f && this.emulator instanceof Emulator) {
					this.emulator.setFliptronicsInput(f, v)
					return true
				}
				return this.emulator.setSwitchInput(n, v)
			},
		)
		this.Dip = this.numProxy(
			n => this.dipCache.get(n) ?? this.emulator.getDipSwitchByte(n),
			(n, v) => {
				this.dipCache.set(n, v & 0xff)
				this.emulator.setDipSwitchByte(v & 0xff, n)
				return true
			},
		)
		this.SolMask = this.numProxy(
			i => this.solMaskCache.get(i) ?? this.emulator.getSolMask?.(i) ?? 0,
			(n, v) => {
				this.solMaskCache.set(n, v)
				this.emulator.setSolMask?.(n, v)
				return true
			},
		)
		this.Lamp = this.numProxy(
			i => this.emulator.getLampState(i),
			() => true,
		)
		this.Solenoid = this.numProxy(
			i => this.emulator.getSolenoidState(i),
			() => true,
		)
		this.GIString = this.numProxy(
			i => this.emulator.getGIState(i),
			() => true,
		)
		this.Mech = this.numProxy(
			() => 0,
			(n, v) => {
				this.stub('Mech', { n, v })
				return true
			},
		)
		this.GetMech = this.numProxy(
			i => {
				this.stub('GetMech', i)
				return 0
			},
			() => false,
		)

		const getGame = (name: string) => {
			const key = String(name ?? '')
			let g = this.gameSettings.get(key)
			if (!g) {
				g = { Settings: { Value: {} as Record<string, unknown> } }
				this.gameSettings.set(key, g)
			}
			return g
		}
		const fn = ((name: string) => getGame(name)) as unknown as Record<string, unknown>
		this.Games = new Proxy(fn, {
			get: (_t, p) =>
				typeof p === 'string' && !['length', 'name', 'prototype'].includes(p)
					? ((fn as Record<string, unknown>)[p] ?? getGame(p))
					: undefined,
			apply: (_t, _this, a) => getGame(String(a[0])),
		})
	}

	get GameName(): string {
		return this.gameName
	}
	set GameName(v: string) {
		if (v === this.gameName) return
		this.gameName = v
		this.loadPromise = this._loadGame(v).catch(e => logger().error('DOWNLOAD_FAILED:', e))
	}
	async whenReady(): Promise<void> {
		if (this.loadPromise) await this.loadPromise
	}

	private async _loadGame(name: string): Promise<void> {
		const existing = this.player.getPhysics().emu
		if (existing?.isInitialized() && existing instanceof PinMameEmulator) {
			this.replay(existing as unknown as IEmulator)
			this.emulator = existing
			return
		}
		// A locally-available ROM (window/global __pendingRom, ?rom= param, or a local file path)
		// always wins over a live network fetch, even for games wpc-emu's bundled GamelistDB knows
		// about - fetchRom() never throws, it returns an empty array when nothing local is found.
		const localRom = await this.fetchRom(name)
		if (localRom.length) {
			const emu = new PinMameEmulator()
			this.replay(emu as unknown as IEmulator)
			this.emulator = emu
			await emu.loadGame(name, localRom)
			this.player.setEmulator(emu)
			this.replay(emu as unknown as IEmulator)
			return
		}
		if (GamelistDB.getByPinmameName(name)) {
			const { wpcDbEntry, romFile } = await downloadGameEntry(name)
			await (this.emulator as Emulator).loadGame(wpcDbEntry, romFile)
			this.replay(this.emulator)
			this.player.setEmulator(this.emulator)
			return
		}
		const emu = new PinMameEmulator()
		this.replay(emu as unknown as IEmulator)
		this.emulator = emu
		await emu.loadGame(name, localRom)
		this.player.setEmulator(emu)
		this.replay(emu as unknown as IEmulator)
	}

	private replay(emu: IEmulator): void {
		for (const [k, v] of this.dipCache) emu.setDipSwitchByte(v & 0xff, k)
		for (const [k, v] of this.solMaskCache) emu.setSolMask?.(k, v)
		for (const [k, v] of this.switchCache) emu.setSwitchInput(k, v)
	}

	private async fetchRom(name: string): Promise<Uint8Array> {
		const pendingWindow = globalThis as unknown as {
			__pendingRom?: Uint8Array
			__pendingRomName?: string
			__pendingRomUrl?: string
		}
		if (
			pendingWindow.__pendingRom?.length &&
			(!pendingWindow.__pendingRomName || pendingWindow.__pendingRomName === name)
		) {
			return pendingWindow.__pendingRom
		}
		if (typeof process !== 'undefined' && process.versions?.node) {
			try {
				const fs = await import('node:fs')
				const path = await import('node:path')
				const os = await import('node:os')
				const candidates = [
					path.join(os.homedir(), '.pinmame', 'roms', `${name}.zip`),
					path.join(process.cwd(), 'test', 'fixtures', `${name}.zip`),
					path.join(os.homedir(), 'Downloads', `${name}.zip`),
					path.join(process.cwd(), 'pinmame', 'roms', `${name}.zip`),
				]
				for (const candidate of candidates) {
					if (fs.existsSync(candidate)) {
						return new Uint8Array(fs.readFileSync(candidate))
					}
				}
			} catch {}
		}
		const romParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('rom') : null
		if (romParam) {
			try {
				const response = await fetch(romParam)
				if (response.ok) return new Uint8Array(await response.arrayBuffer())
			} catch {}
		}
		if (typeof location !== 'undefined') {
			for (const url of [
				`/@fs${location.pathname.startsWith('/home') ? '' : '/home/qinghao1'}/.pinmame/roms/${name}.zip`,
				`/pinmame/roms/${name}.zip`,
				`/roms/${name}.zip`,
			]) {
				try {
					const response = await fetch(url)
					if (response.ok) return new Uint8Array(await response.arrayBuffer())
				} catch {}
			}
		}
		logger().warn(`[pinmame] no ROM for ${name} — mock`)
		return new Uint8Array()
	}

	get ROMName(): string {
		return this.gameName
	}
	get Running(): boolean {
		return this.emulator.isInitialized() && !this.emulator.getPaused()
	}
	get Pause(): boolean {
		return this.emulator.getPaused()
	}
	set Pause(v: boolean) {
		this.emulator.setPaused(v)
	}
	get Version(): string {
		return '03070000'
	}
	get TimeFence(): number {
		return this.timeFence
	}
	set TimeFence(v: number) {
		this.timeFence = v
		;(this.emulator as unknown as { setTimeFence?: (t: number) => void }).setTimeFence?.(v)
	}
	Run(nMinVersion = 0, hParentWnd = 0): void {
		if (!this.gameName) {
			this.stub('Run', { nMinVersion, hParentWnd })
			return
		}
		if (!this.loadPromise)
			this.loadPromise = this._loadGame(this.gameName).catch(e => logger().error('DOWNLOAD_FAILED:', e))
		logger().debug('RUN', this.gameName)
	}
	Stop(): void {
		logger().debug('STOP')
		this.emulator.setPaused(true)
	}

	get WPCNumbering(): number {
		return 1
	}
	get SampleRate(): number {
		return 22050
	}
	get SplashInfoLine(): string {
		return this.splashInfoLine
	}
	set SplashInfoLine(v: string) {
		this.splashInfoLine = v
	}
	get HandleMechanics(): number {
		return 0
	}
	set HandleMechanics(v: number) {
		this.stub('HandleMechanics', v)
	}

	get NVRAM(): Uint8Array {
		return new Uint8Array()
	}
	get ChangedNVRAM(): number[][] {
		return []
	}
	get NewSoundCommands(): number[][] {
		return []
	}
	get RawDmdWidth(): number {
		try {
			return this.emulator.getDmdDimensions().x
		} catch {
			return 0
		}
	}
	get RawDmdHeight(): number {
		try {
			return this.emulator.getDmdDimensions().y
		} catch {
			return 0
		}
	}
	get RawDmdPixels(): Uint8Array {
		try {
			return this.emulator.getDmdFrame()
		} catch {
			return new Uint8Array()
		}
	}
	get RawDmdColoredPixels(): Uint32Array {
		return new Uint32Array(this.RawDmdPixels.length)
	}

	SetDisplayPosition(x: number, y: number, hWnd: unknown): void {
		this.stub('SetDisplayPosition', { x, y, hWnd })
	}
	ShowOptsDialog(hWnd: unknown): void {
		this.stub('ShowOptsDialog', hWnd)
	}
	ShowPathesDialog(hWnd: unknown): void {
		this.stub('ShowPathesDialog', hWnd)
	}
	ShowAboutDialog(hWnd: unknown): void {
		this.stub('ShowAboutDialog', hWnd)
	}
	CheckROMS(n: number): boolean {
		this.stub('CheckROMS', n)
		return true
	}

	get ChangedLamps(): VbsArray<number[]> {
		return this.emulator.emulatorState.getChangedLamps()
	}
	get ChangedSolenoids(): number[][] {
		return this.emulator.emulatorState.getChangedSolenoids()
	}
	get ChangedGI(): number[][] {
		return this.emulator.emulatorState.getChangedGI()
	}
	get ChangedLEDs(): VbsArray<number[]> {
		return this.emulator.emulatorState.getChangedLEDs() as unknown as VbsArray<number[]>
	}

	private stub(name: string, v?: unknown): void {
		logger().debug(name, v)
	}

	private numProxy(get: (n: number) => number, set: (n: number, v: number) => boolean): Record<number, number> {
		return new Proxy({} as Record<number, number>, {
			get: (_, p) => {
				if (typeof p === 'symbol') return undefined as any
				const n = Number(p)
				if (Number.isNaN(n)) return undefined as any
				return get(n)
			},
			set: (_, p, v) => {
				if (typeof p === 'symbol') return false
				const n = Number(p)
				if (Number.isNaN(n)) return false
				return set(n, v as number)
			},
		})
	}
	private boolProxy(get: (n: number) => number, set: (n: number, v?: boolean) => boolean): Record<number, number> {
		return new Proxy({} as Record<number, number>, {
			get: (_, p) => {
				if (typeof p === 'symbol') return undefined as any
				const n = Number(p)
				if (Number.isNaN(n)) return undefined as any
				return get(n)
			},
			set: (_, p, v) => {
				if (typeof p === 'symbol') return false
				const n = Number(p)
				if (Number.isNaN(n)) return false
				if (v === 1 || v === true) return set(n, true)
				if (v === 0 || v === false) return set(n, false)
				return set(n)
			},
		})
	}

	static {
		const bools = [
			'ShowFrame',
			'DoubleSize',
			'Antialias',
			'LockDisplay',
			'Hidden',
			'ShowDMDOnly',
			'HandleKeyboard',
			'ShowTitle',
			'ShowPinDMD',
			'ShowWinDMD',
		] as const
		for (const k of bools)
			Object.defineProperty(VpmController.prototype, k, {
				get(this: VpmController) {
					return false
				},
				set(this: VpmController, v: any) {
					this.stub(k, v)
				},
				configurable: true,
				enumerable: true,
			})
		const ints = [
			'BorderSizeX',
			'BorderSizeY',
			'WindowPosX',
			'WindowPosY',
			'FastFrames',
			'CabinetMode',
			'SoundMode',
			'IgnoreRomCrc',
		] as const
		for (const k of ints)
			Object.defineProperty(VpmController.prototype, k, {
				get(this: VpmController) {
					return 0
				},
				set(this: VpmController, v: any) {
					this.stub(k, v)
				},
				configurable: true,
				enumerable: true,
			})
	}
}
