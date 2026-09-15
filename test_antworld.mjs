import { Player, Table } from './dist/index.js'
import { BinaryReader } from './dist/lib/refs.node.js'

const table = await Table.load(new BinaryReader('./table_antworld.vpx'))
console.log('Table:', table.info?.TableName, '- items:', Object.keys(table.items || {}).length)
console.log('Kickers:', Object.keys(table.kickers || {}))
console.log('Gates:', Object.keys(table.gates || {}))

const player = new Player(table).init()
console.log('Player initialized')

table.kickers.BallRelease.getApi().CreateBall()
table.kickers.BallRelease.getApi().Kick(90, 8)
console.log('CreateBall + Kick called, no error')

process.on('unhandledRejection', e => console.log('(non-fatal background rejection):', e.message || e))

function dumpBalls(label) {
	const balls = player.getBalls()
	console.log(
		label,
		balls.map(b => ({ x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z, vx: b.hit.vel.x, vy: b.hit.vel.y })),
	)
}

dumpBalls('t=0:')
for (let i = 1; i <= 5; i++) {
	player.simulateTime(200)
	dumpBalls(`t=${i * 0.2}s:`)
}
