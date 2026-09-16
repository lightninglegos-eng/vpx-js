// Copyright (C) 2019 freezy <freezy@vpdb.io> — GPL-2.0 — see LICENSE
// Copyright (C) 2026 Chu Qinghao <6337103+qinghao1@users.noreply.github.com> — GPL-2.0 — see LICENSE

import { concatUint8Arrays, decodeUtf8, readInt32LE, readUInt16LE } from '../io/binary-helpers.js'
import type { Storage } from '../io/ole-doc.js'

const WAVEFORMATEX_BASE_SIZE = 18 // wFormatTag,nChannels,nSamplesPerSec,nAvgBytesPerSec,nBlockAlign,wBitsPerSample,cbSize

/**
 * VPinball sound sample — `Sound*` storage entry.
 *
 * Unlike most VPX items (`Image*`, game items, …) this isn't BIFF-tagged - it's a fixed,
 * length-prefixed binary layout written directly by the original Windows loader. WAV samples
 * are stored as a raw `WAVEFORMATEX` header + PCM payload (VP originally imported WAVs through
 * a Windows API that strips the RIFF container); everything else (e.g. OGG) keeps its own
 * original file header as-is.
 * @see https://github.com/vpinball/vpinball/blob/master/src/audio/Sound.cpp
 */
export class Sound {
	public storageName?: string
	public name!: string
	public path!: string
	public isWav!: boolean
	/** A complete, directly-decodable WAV file (RIFF header rebuilt from the embedded WAVEFORMATEX) - only set for WAV samples. */
	public wavBytes?: Uint8Array
	/** The sample's original bytes, container and all - only set for non-WAV samples (e.g. OGG), which already have a real header. */
	public rawBytes?: Uint8Array

	private constructor() {}

	public static async fromStorage(storage: Storage, itemName: string): Promise<Sound> {
		const sound = new Sound()
		sound.storageName = itemName
		let offset = 0

		const readLengthPrefixed = async (): Promise<Uint8Array> => {
			const lenBuf = await storage.read(itemName, offset, 4)
			offset += 4
			const len = readInt32LE(lenBuf, 0)
			if (len <= 0) return new Uint8Array(0)
			const buf = await storage.read(itemName, offset, len)
			offset += len
			return buf
		}

		sound.name = decodeUtf8(await readLengthPrefixed())
		sound.path = decodeUtf8(await readLengthPrefixed())
		await readLengthPrefixed() // legacy lowercase name, unused since 10.7+

		sound.isWav = /\.wav$/i.test(sound.path)

		let wfx: Uint8Array | undefined
		if (sound.isWav) {
			const wfxBase = await storage.read(itemName, offset, WAVEFORMATEX_BASE_SIZE)
			const cbSize = readUInt16LE(wfxBase, 16)
			offset += WAVEFORMATEX_BASE_SIZE
			if (cbSize > 0) {
				const extra = await storage.read(itemName, offset, cbSize)
				offset += cbSize
				wfx = concatUint8Arrays(wfxBase, extra)
			} else {
				wfx = wfxBase
			}
		}

		const dataLenBuf = await storage.read(itemName, offset, 4)
		offset += 4
		const dataLen = readInt32LE(dataLenBuf, 0)
		const data = dataLen > 0 ? await storage.read(itemName, offset, dataLen) : new Uint8Array(0)

		if (sound.isWav && wfx) {
			sound.wavBytes = Sound.buildWavFile(wfx, data)
		} else {
			sound.rawBytes = data
		}

		return sound
	}

	/** Reassembles a standard, directly-playable RIFF/WAVE file from a raw WAVEFORMATEX header + PCM payload. */
	private static buildWavFile(wfx: Uint8Array, data: Uint8Array): Uint8Array {
		const fmtChunkSize = wfx.length
		const dataChunkSize = data.length
		const riffChunkSize = 4 + (8 + fmtChunkSize) + (8 + dataChunkSize) // "WAVE" + fmt chunk + data chunk
		const buf = new Uint8Array(8 + riffChunkSize) // "RIFF" + size + riffChunkSize
		const dv = new DataView(buf.buffer)
		let o = 0
		const tag = (s: string) => {
			for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i)
			o += 4
		}
		tag('RIFF')
		dv.setUint32(o, riffChunkSize, true)
		o += 4
		tag('WAVE')
		tag('fmt ')
		dv.setUint32(o, fmtChunkSize, true)
		o += 4
		buf.set(wfx, o)
		o += fmtChunkSize
		tag('data')
		dv.setUint32(o, dataChunkSize, true)
		o += 4
		buf.set(data, o)
		return buf
	}

	/** The bytes to hand to `AudioContext.decodeAudioData()` - a real WAV file, or the sample's own original container. */
	public getPlayableBytes(): Uint8Array | undefined {
		return this.wavBytes ?? this.rawBytes
	}

	public getName(): string {
		return (this.name || '').toLowerCase()
	}
}
