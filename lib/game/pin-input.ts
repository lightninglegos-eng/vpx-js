// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import { NudgeHandler } from '../physics/cabinet/nudge-handler.js'
import type { Vertex2D } from '../util/vector.js'
import type { Table } from '../vpt/table/table.js'
import { Event } from './event.js'
import {
	AssignKey,
	DIK_1,
	DIK_2,
	DIK_3,
	DIK_4,
	DIK_5,
	DIK_6,
	DIK_D,
	DIK_EQUALS,
	DIK_ESCAPE,
	DIK_F10,
	DIK_F11,
	DIK_LALT,
	DIK_LCONTROL,
	DIK_LEFT,
	DIK_LSHIFT,
	DIK_MINUS,
	DIK_O,
	DIK_Q,
	DIK_RCONTROL,
	DIK_RETURN,
	DIK_RIGHT,
	DIK_RSHIFT,
	DIK_SLASH,
	DIK_SPACE,
	DIK_T,
	DIK_Z,
} from './key-code.js'
import type { Player } from './player.js'

type KeyEvent = { code: number; down: boolean }

const DEFAULT_KEYS: Record<number, number> = {
	[AssignKey.LeftFlipperKey]: DIK_LSHIFT,
	[AssignKey.RightFlipperKey]: DIK_RSHIFT,
	[AssignKey.LeftTiltKey]: DIK_Z,
	[AssignKey.RightTiltKey]: DIK_SLASH,
	[AssignKey.CenterTiltKey]: DIK_SPACE,
	[AssignKey.PlungerKey]: DIK_RETURN,
	[AssignKey.FrameCount]: DIK_F11,
	[AssignKey.DBGBalls]: DIK_O,
	[AssignKey.Debugger]: DIK_D,
	[AssignKey.AddCreditKey]: DIK_5,
	[AssignKey.AddCreditKey2]: DIK_4,
	[AssignKey.StartGameKey]: DIK_1,
	[AssignKey.MechanicalTilt]: DIK_T,
	[AssignKey.RightMagnaSave]: DIK_RCONTROL,
	[AssignKey.LeftMagnaSave]: DIK_LCONTROL,
	[AssignKey.ExitGame]: DIK_Q,
	[AssignKey.VolumeUp]: DIK_EQUALS,
	[AssignKey.VolumeDown]: DIK_MINUS,
	[AssignKey.LockbarKey]: DIK_LALT,
	[AssignKey.Enable3D]: DIK_F10,
	[AssignKey.Escape]: DIK_ESCAPE,
}

// Cabinet switches from vpinball InputManager.cpp; free-play coin search mirrors
// Jakobud/freeplay MAME plugin (init.lua: search ioport fields by name "Free Play"):
// we search tableScript for "Const swCoin* = N" by name (driver-agnostic) and use the
// script's AddCreditKey path (vpmKeyDown -> PulseSw) plus a tiny direct pulse for timing.
const SWITCH_START = [16, 13, 1] as const
const SWITCH_CREDIT_2_3 = [65, 1, 2, 3, 4] as const
const SWITCH_CREDIT_4 = [66, 2, 1, 65, 67] as const
const SWITCH_CREDIT_5 = [67, 3, 1, 2, 65, 66, 68] as const
const SWITCH_CREDIT_6 = [68, 4, 1, 67] as const
const SWITCH_FLIPPER_L = [84, 114, 112] as const
const SWITCH_FLIPPER_R = [82, 86, 112, 116] as const

const TROUGH_KICK_ANGLE = 60
const TROUGH_KICK_SPEED = 10

function isLeftCode(code: number, leftKey: number): boolean {
	return code === leftKey || code === DIK_LEFT
}

function isRightCode(code: number, rightKey: number): boolean {
	return code === rightKey || code === DIK_RIGHT
}

export class PinInput {
	private readonly queue: KeyEvent[] = []
	private readonly pressed = new Set<number>()
	private readonly nudgeHandler = new NudgeHandler()

	readonly rgKeys: Record<number, number> = { ...DEFAULT_KEYS }
	public freePlay = true
	private cachedCoinSwitches: number[] | null = null

	constructor(
		private readonly table: Table,
		private readonly player: Player,
	) {}

	getKey(key: AssignKey): number {
		return this.rgKeys[key] ?? 0
	}

	setKey(key: AssignKey, dik: number): void {
		this.rgKeys[key] = dik
	}

	getNudgeHandler(): NudgeHandler {
		return this.nudgeHandler
	}

	getCabinetAcceleration(): Vertex2D {
		return this.nudgeHandler.getCabinetAcceleration()
	}

	getCabinetOffset(): Vertex2D {
		return this.nudgeHandler.getCabinetOffset()
	}

	tickNudge(): void {
		this.nudgeHandler.stepOneMillisecond()
	}

	nudge(angle: number, force: number): void {
		this.nudgeHandler.applyImpulse(angle, force)
	}

	private pulseSwitches(switches: readonly number[]): void {
		const emu = this.player.getPhysics().emu
		if (!emu) return
		for (const sw of switches) {
			emu.setSwitchInput(sw, true)
		}
		setTimeout(() => {
			for (const sw of switches) {
				emu.setSwitchInput(sw, false)
			}
		}, 120)
	}

	private discoverCoinSwitches(): number[] {
		if (this.cachedCoinSwitches) return this.cachedCoinSwitches
		const script = (this.table as unknown as { tableScript?: string }).tableScript ?? ''
		const re = /Const\s+swCoin\d*\s*=\s*(-?\d+)/gi
		const seen = new Set<number>()
		const out: number[] = []
		let m: RegExpExecArray | null
		while ((m = re.exec(script))) {
			const v = Number.parseInt(m[1] ?? '', 10)
			if (Number.isFinite(v) && v >= 0 && !seen.has(v)) {
				seen.add(v)
				out.push(v)
			}
		}
		if (out.length) {
			this.cachedCoinSwitches = out
			return out
		}
		return [65, 1, 2]
	}

	public addCredit(count = 1): void {
		const key = this.getKey(AssignKey.AddCreditKey)
		const direct = this.discoverCoinSwitches().slice(0, 3)
		for (let i = 0; i < count; i++) {
			setTimeout(() => {
				this.onKeyDown(key)
				setTimeout(() => {
					this.onKeyUp(key)
				}, 120)
				this.pulseSwitches(direct)
			}, i * 250)
		}
	}

	public ensureFreePlay(): void {
		if (!this.freePlay) return
		this.addCredit(3)
		setTimeout(() => this.addCredit(2), 1500)
		setTimeout(() => this.addCredit(2), 3500)
	}

	onKeyDown(code: number, _ts?: number): void {
		this.queue.push({ code, down: true })
	}

	onKeyUp(code: number, _ts?: number): void {
		this.queue.push({ code, down: false })
	}

	processKeys(): void {
		if (!this.queue.length) return
		const queued = this.queue.splice(0, this.queue.length)
		for (const ev of queued) {
			if (
				ev.code === this.rgKeys[AssignKey.FrameCount] ||
				ev.code === this.rgKeys[AssignKey.Enable3D] ||
				ev.code === this.rgKeys[AssignKey.DBGBalls]
			)
				continue
			if (ev.down) {
				if (this.pressed.has(ev.code)) continue
				this.pressed.add(ev.code)
			} else {
				this.pressed.delete(ev.code)
			}
			this.fire(ev.down ? Event.GameEventsKeyDown : Event.GameEventsKeyUp, ev.code)
		}
	}

	private fire(dispId: Event, code: number): void {
		const prevNudgeIndex = this.nudgeHandler.getIndex()
		this.table.getApi().fireKeyEvent(dispId, code)
		const isDown = dispId === Event.GameEventsKeyDown
		this.syncFlippers(isDown, code)
		this.syncPlunger(isDown, code)
		this.syncNudge(isDown, code, prevNudgeIndex)
		this.syncCabinet(isDown, code)
		this.tryMockTroughEject(isDown, code)
	}

	private isRightFlipper(flipper: { getName(): string; data: { center: { x: number } } }): boolean {
		const name = flipper.getName().toLowerCase()
		if (name.includes('right') || name === 'flipperr') return true
		if (name.includes('left')) return false
		const d = this.table.data
		if (d && typeof d.left === 'number' && typeof d.right === 'number') {
			const mid = (d.left + d.right) / 2
			return flipper.data.center.x > mid
		}
		return false
	}

	private syncFlippers(isDown: boolean, code: number): void {
		const isLeft = isLeftCode(code, this.getKey(AssignKey.LeftFlipperKey))
		const isRight = isRightCode(code, this.getKey(AssignKey.RightFlipperKey))
		if (!isLeft && !isRight) return
		const flippers = Object.values(this.table.flippers) as Array<{
			getName(): string
			data: { center: { x: number } }
			getApi(): { RotateToEnd(): void; RotateToStart(): void }
		}>
		if (!flippers.length) return
		for (const flipper of flippers) {
			if (flippers.length > 1) {
				const isRightFlipper = this.isRightFlipper(flipper)
				if (isLeft && isRightFlipper) continue
				if (isRight && !isRightFlipper) continue
			}
			const api = flipper.getApi()
			if (isDown) api.RotateToEnd()
			else api.RotateToStart()
		}
	}

	private syncPlunger(isDown: boolean, code: number): void {
		if (code !== this.getKey(AssignKey.PlungerKey)) return
		const plungers = Object.values(this.table.plungers) as Array<{
			getApi(): { PullBack(): void; Fire(): void }
		}>
		if (!plungers.length) return
		for (const plunger of plungers) {
			const api = plunger.getApi()
			if (isDown) api.PullBack()
			else api.Fire()
		}
	}

	private syncNudge(isDown: boolean, code: number, prevIndex: number): void {
		if (!isDown) return
		if (prevIndex !== this.nudgeHandler.getIndex()) return
		const leftKey = this.getKey(AssignKey.LeftTiltKey)
		const rightKey = this.getKey(AssignKey.RightTiltKey)
		const centerKey = this.getKey(AssignKey.CenterTiltKey)
		if (code !== leftKey && code !== rightKey && code !== centerKey) return
		const baseForce = 2
		const angleVariance = (Math.random() - 0.5) * 15 * baseForce
		const force = (0.6 + Math.random() * 0.8) * baseForce
		let angle: number
		if (code === leftKey) angle = 75 + angleVariance
		else if (code === rightKey) angle = 285 + angleVariance
		else angle = angleVariance
		this.nudgeHandler.applyImpulse(angle, force)
	}

	private tryMockTroughEject(isDown: boolean, code: number): void {
		if (!isDown) return
		if (code !== DIK_1 && code !== this.getKey(AssignKey.StartGameKey)) return
		const emu = this.player.getPhysics().emu as unknown as {
			isMock?: boolean
			isInitialized?: () => boolean
		} | null
		if (emu && !emu.isMock && emu.isInitialized?.()) return
		const kickers = Object.values(this.table.kickers) as unknown as Array<{
			hit?: { ball?: unknown }
			getApi(): { Kick(a: number, s: number): void; DestroyBall(): number }
			getName(): string
			data: { center: { x: number } }
		}>
		const withBall = kickers.filter(k => (k as unknown as { hit?: { ball?: unknown } }).hit?.ball)
		if (!withBall.length) {
			if (this.player.getPhysics().balls.length > 0) return
			const plunger = Object.values(this.table.plungers)[0] as unknown as
				| { getApi(): { CreateBall(): unknown } }
				| undefined
			if (plunger) {
				plunger.getApi().CreateBall()
			}
			return
		}
		withBall.sort((a, b) => b.data.center.x - a.data.center.x)
		const exit = withBall[0] as (typeof withBall)[number]
		if (!exit) return
		exit.getApi().Kick(TROUGH_KICK_ANGLE, TROUGH_KICK_SPEED)
	}

	private syncCabinet(isDown: boolean, code: number): void {
		const emu = this.player.getPhysics().emu
		if (!emu) return
		if (this.freePlay && isDown && (code === DIK_1 || code === this.getKey(AssignKey.StartGameKey))) {
			this.pulseSwitches(this.discoverCoinSwitches())
		}
		const switches = this.getCabinetSwitches(code)
		if (!switches) return
		for (const sw of switches) {
			emu.setSwitchInput(sw, isDown)
		}
	}

	private getCabinetSwitches(code: number): readonly number[] | undefined {
		if (code === DIK_1 || code === this.getKey(AssignKey.StartGameKey)) return SWITCH_START
		if (code === DIK_2 || code === DIK_3) return SWITCH_CREDIT_2_3
		if (code === DIK_4 || code === this.getKey(AssignKey.AddCreditKey2)) return SWITCH_CREDIT_4
		if (code === DIK_5 || code === this.getKey(AssignKey.AddCreditKey)) return SWITCH_CREDIT_5
		if (code === DIK_6) return SWITCH_CREDIT_6
		if (isLeftCode(code, this.getKey(AssignKey.LeftFlipperKey))) return SWITCH_FLIPPER_L
		if (isRightCode(code, this.getKey(AssignKey.RightFlipperKey))) return SWITCH_FLIPPER_R
		return undefined
	}
}
