import { db } from './db.js'
import { cropLike } from './breeding.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 灌溉参数 =====
export const COSTS = { reservoir: 60, canal: 8 }   // 建造花费（金币）
export const RESERVOIR_CAP = 150                   // 蓄水池容量
export const RESERVOIR_INIT = 50                   // 建成时自带水量
export const DEMOLISH_REFUND = 0.5                 // 拆除返还比例
export const MAP_W = 15                            // 地图格数（900/60）
export const MAP_H = 10                            // 地图格数（620/60 取整）
export const TARGET_DEFAULT = 100                  // 地块默认目标水分
const ALLOC_KEEP_DAYS = 7                          // 分配结果保留天数

// 天气对蓄水池的每日影响：正=降雨补水，负=蒸发耗水（负值乘灾害等级）
const WEATHER_WATER = { rain: 35, storm: 50, drought: -15, heatwave: -8 }

// 地块日均耗水基准（与逐日结算 12+rand(0..12) 的期望一致），品种性状按倍率修正
const DAILY_USE_BASE = 18

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// 建筑占地（2x2）不可建灌溉设施
function blockedCells() {
  const blocked = new Set()
  for (const b of q('SELECT x,y FROM buildings')) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) blocked.add(`${b.x + dx},${b.y + dy}`)
    }
  }
  return blocked
}

// 地块目标水分（旧存档无 irr_target 列时由 db.js 补列，默认 100）
function targetOf(plot) {
  const t = Number(plot.irr_target)
  return Number.isFinite(t) ? Math.max(0, Math.min(100, t)) : TARGET_DEFAULT
}

// 品种日耗水倍率：抗旱减半、脆弱放大（与 advanceDay 的 waterDecayMul 对齐）
function waterUseMul(crop) {
  if (!crop || !crop.isVariety) return 1
  const t = new Set(crop.traits)
  return (t.has('droughthardy') ? 0.5 : 1) * (t.has('weak') ? 1.5 : 1)
}

// ===== 供水网络 =====
// 启用中的蓄水池与水渠按 4 连通分成若干网络（连通分量）；
// 同一网络内的多座蓄水池水量打通、统一分水，网络之间互不相通。
// 停用/拆除的设施不参与，因此断流与恢复都由每次实时重算自然生效。
function supplyNetworks() {
  const facilities = q('SELECT * FROM irrigation WHERE active=1')
  const plots = q('SELECT id,x,y,water,crop_id,irr_priority,irr_target FROM plots')
  const at = new Map(facilities.map((f) => [`${f.x},${f.y}`, f]))
  const plotAt = new Map(plots.map((p) => [`${p.x},${p.y}`, p]))
  const seen = new Set()
  const nets = []
  for (const f of facilities) {
    if (seen.has(f.id)) continue
    // BFS 收集同一连通分量的设施与相邻地块
    const reservoirs = []
    const canalIds = new Set()
    const plotIds = new Set()
    const stack = [f]
    seen.add(f.id)
    while (stack.length) {
      const cur = stack.pop()
      if (cur.kind === 'reservoir') reservoirs.push(cur)
      else canalIds.add(cur.id)
      for (const [dx, dy] of DIRS) {
        const key = `${cur.x + dx},${cur.y + dy}`
        const nb = at.get(key)
        if (nb && !seen.has(nb.id)) {
          seen.add(nb.id)
          stack.push(nb)
          continue
        }
        const plot = plotAt.get(key)
        if (plot) plotIds.add(plot.id) // 地块与设施相邻即接通，不再向外延伸
      }
    }
    if (reservoirs.length) nets.push({ reservoirs, canalIds, plotIds })
  }
  return { nets, plots }
}

// 当前供水网络：启用中的蓄水池沿启用水渠能到达的 { plotIds, canalIds }，
// 并附每个网络的概览（联网池数/总水量/需求/预计日耗），供前端展示与每日结算共用
export function networkInfo() {
  const { nets, plots } = supplyNetworks()
  const plotIds = new Set()
  const canalIds = new Set()
  const networks = nets.map((net, i) => {
    net.plotIds.forEach((id) => plotIds.add(id))
    net.canalIds.forEach((id) => canalIds.add(id))
    // 需求与预计日耗：只算有作物且低于目标水分的地块；品种耗水按性状折算
    let demand = 0
    let dailyUse = 0
    let planted = 0
    for (const p of plots) {
      if (!net.plotIds.has(p.id) || !p.crop_id) continue
      planted++
      demand += Math.max(0, targetOf(p) - p.water)
      dailyUse += DAILY_USE_BASE * waterUseMul(cropLike(p.crop_id))
    }
    return {
      id: i + 1,
      reservoirs: net.reservoirs.length,
      water: Math.round(net.reservoirs.reduce((s, r) => s + r.water, 0)),
      cap: net.reservoirs.length * RESERVOIR_CAP,
      plots: planted,
      demand: Math.round(demand),
      dailyUse: Math.round(dailyUse)
    }
  })
  return { plotIds, canalIds, networks }
}

// 最近一天的逐地块分配结果（缺水时前端展示明细）
export function latestAlloc() {
  const last = q1('SELECT MAX(abs_day) d FROM irrigation_alloc')
  if (!last || last.d == null) return { day: null, rows: [] }
  const rows = q(
    `SELECT a.net, a.need, a.given, p.id AS plot_id, p.x, p.y
     FROM irrigation_alloc a JOIN plots p ON p.id = a.plot_id
     WHERE a.abs_day=? ORDER BY a.net, a.given >= a.need, a.need DESC`, last.d)
  return { day: last.d, rows }
}

// ===== 建造/停用/拆除 =====
// 建造蓄水池/水渠：校验地块、占用与金币，事务落库
export function buildFacility(kind, x, y) {
  if (!COSTS[kind]) throw Object.assign(new Error('未知的设施类型'), { status: 400 })
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) {
    throw Object.assign(new Error('超出可建造范围'), { status: 400 })
  }
  if (q1('SELECT id FROM plots WHERE x=? AND y=?', x, y)) {
    throw Object.assign(new Error('不能建在耕地上，请铺到耕地旁'), { status: 400 })
  }
  if (blockedCells().has(`${x},${y}`)) {
    throw Object.assign(new Error('此处已被建筑占用'), { status: 400 })
  }
  if (q1('SELECT id FROM irrigation WHERE x=? AND y=?', x, y)) {
    throw Object.assign(new Error('此处已有灌溉设施'), { status: 400 })
  }
  const cost = COSTS[kind]
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) throw Object.assign(new Error('金币不足'), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE player SET gold=gold-? WHERE id=1', cost)
    const r = run(
      'INSERT INTO irrigation (kind,x,y,active,water) VALUES (?,?,?,1,?)',
      kind, x, y, kind === 'reservoir' ? RESERVOIR_INIT : 0
    )
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid, cost, ...networkSummary() }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 供水网络重算摘要：停用/拆除/建造后即时返回，前端据此提示断流变化
function networkSummary() {
  const net = networkInfo()
  return { nets: net.networks.length, served: net.plotIds.size }
}

// 停用/启用：停用即断流（不再参与供水网络），启用后次日结算自动恢复
export function toggleFacility(id) {
  const f = q1('SELECT * FROM irrigation WHERE id=?', id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const active = f.active ? 0 : 1
  run('UPDATE irrigation SET active=? WHERE id=?', active, id)
  return { ok: true, active, ...networkSummary() }
}

// 拆除：返还部分造价，蓄水池余水作废；断流的地块由网络重算自动体现
export function demolishFacility(id) {
  const f = q1('SELECT * FROM irrigation WHERE id=?', id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const refund = Math.floor(COSTS[f.kind] * DEMOLISH_REFUND)
  db.exec('BEGIN IMMEDIATE')
  try {
    run('DELETE FROM irrigation WHERE id=?', id)
    if (refund > 0) run('UPDATE player SET gold=gold+? WHERE id=1', refund)
    db.exec('COMMIT')
    return { ok: true, refund, ...networkSummary() }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 设置地块目标水分（0~100；0 = 不自动浇水），旧地块未设置时按 100 处理
export function setPlotTarget(plotId, target) {
  const t = Math.max(0, Math.min(100, Math.round(Number(target))))
  if (!Number.isFinite(t)) throw Object.assign(new Error('目标水分无效'), { status: 400 })
  if (!q1('SELECT id FROM plots WHERE id=?', plotId)) {
    throw Object.assign(new Error('地块不存在'), { status: 404 })
  }
  run('UPDATE plots SET irr_target=? WHERE id=?', t, plotId)
  return { ok: true, target: t }
}

// ===== 逐日结算 =====
// 统一分水：从联网池群中按各池水量占比扣减 used，保持各池水位均衡
function drainPool(reservoirs, used) {
  const total = reservoirs.reduce((s, r) => s + r.water, 0)
  if (total <= 0 || used <= 0) return
  let left = Math.min(used, total)
  reservoirs.forEach((r, i) => {
    // 最后一池兜底，吸收比例分摊的取整误差
    let take = i === reservoirs.length - 1 ? left : Math.min(r.water, used * (r.water / total))
    take = Math.max(0, Math.min(take, r.water, left))
    if (take <= 0) return
    run('UPDATE irrigation SET water=? WHERE id=?', Math.round((r.water - take) * 10) / 10, r.id)
    left -= take
  })
}

// 逐日结算（在 advanceDay 事务内调用，不另开事务）：
// 1) 天气影响：降雨/暴雨为蓄水池补水，干旱/酷暑加速蒸发
// 2) 统一分水：同一连通网络内的多座蓄水池水量打通，按
//    「优先级高→低，同级距目标水分越急迫越先」把池群水量分配到地块，耗尽即止；
//    每块地只浇到其目标水分（地块日耗已含品种性状折算，在作物结算时扣除）
// 3) 分配结果落库（缺水明细）+ 干涸断流预警
export function settleIrrigation(weatherType, severity = 0, absDay = 0) {
  const logs = []
  const reservoirs = q("SELECT * FROM irrigation WHERE kind='reservoir'")
  if (!reservoirs.length) return logs

  // —— 天气补水/耗水 ——
  const delta = WEATHER_WATER[weatherType] || 0
  if (delta !== 0) {
    const d = delta < 0 ? delta * Math.max(1, severity) : delta
    for (const r of reservoirs) {
      const w = Math.max(0, Math.min(RESERVOIR_CAP, r.water + d))
      if (w !== r.water) run('UPDATE irrigation SET water=? WHERE id=?', w, r.id)
    }
    logs.push(delta > 0
      ? `🌧️ 降水为所有蓄水池补水 +${d}`
      : `🏜️ 干热蒸发，所有蓄水池水量 ${d}`)
  }

  // —— 按连通网络统一分水 ——
  const { nets } = supplyNetworks()
  const allocs = []
  const netLogs = []
  const fedPlots = new Set()
  let totalUsed = 0
  nets.forEach((net, idx) => {
    const netNo = idx + 1
    const pool = net.reservoirs.reduce((s, r) => s + r.water, 0)
    if (pool <= 0) return
    // 每个网络分配前重读地块水分，避免不同网络连通同一地块时按旧值重复供水
    const plots = q('SELECT * FROM plots')
    // 只浇有作物且低于目标水分的地块；优先级高→低，同级距目标越急迫（比例越低）越先
    const targets = plots
      .filter((p) => net.plotIds.has(p.id) && p.crop_id)
      .map((p) => ({ p, target: targetOf(p), need: Math.max(0, targetOf(p) - p.water) }))
      .filter((t) => t.need > 0.5)
      .sort((a, b) =>
        b.p.irr_priority - a.p.irr_priority ||
        (a.p.water / Math.max(1, a.target)) - (b.p.water / Math.max(1, b.target)) ||
        a.p.water - b.p.water)
    if (!targets.length) return
    let used = 0
    const short = []
    for (const t of targets) {
      const give = Math.max(0, Math.min(t.need, pool - used))
      if (give > 0.05) {
        run('UPDATE plots SET water=MIN(100, water+?) WHERE id=?', give, t.p.id)
        used += give
        fedPlots.add(t.p.id)
      }
      allocs.push({ net: netNo, plot_id: t.p.id, need: Math.round(t.need), given: Math.round(give) })
      if (give < t.need - 0.5) short.push({ p: t.p, need: t.need, give })
    }
    if (used > 0) {
      drainPool(net.reservoirs, used)
      totalUsed += used
    }
    netLogs.push(short.length
      ? `🚱 网络#${netNo} 水量不足（${net.reservoirs.length} 池联网）：` +
        short.map((s) => `地块(${s.p.x},${s.p.y}) 需${Math.round(s.need)}仅供${Math.round(s.give)}`).join('、')
      : `💧 网络#${netNo} 统一分水：${targets.length} 块地浇至目标水分，共供水 ${Math.round(used)}`)
  })
  if (fedPlots.size) {
    logs.push(`💧 灌溉完成：${fedPlots.size} 块地共供水 ${Math.round(totalUsed)}`)
  }
  logs.push(...netLogs)

  // —— 分配结果落库（同日幂等），缺水明细供前端展示 ——
  // 同一地块可能被多个网络覆盖：按地块合并，实供水量累加，网络号取贡献最大者
  if (allocs.length && absDay) {
    const byPlot = new Map()
    for (const a of allocs) {
      const cur = byPlot.get(a.plot_id)
      if (!cur) {
        byPlot.set(a.plot_id, { ...a, topGive: a.given })
      } else {
        cur.given += a.given
        cur.need = Math.max(cur.need, a.need)
        if (a.given > cur.topGive) { cur.net = a.net; cur.topGive = a.given }
      }
    }
    const ins = db.prepare(
      'INSERT OR REPLACE INTO irrigation_alloc (abs_day,net,plot_id,need,given) VALUES (?,?,?,?,?)')
    for (const a of byPlot.values()) ins.run(absDay, a.net, a.plot_id, a.need, a.given)
    run('DELETE FROM irrigation_alloc WHERE abs_day<?', absDay - ALLOC_KEEP_DAYS)
  }

  // —— 干涸断流预警：网络启用但池群无水，且连通地块仍有作物缺水 ——
  const plots = q('SELECT * FROM plots')
  nets.forEach((net, idx) => {
    const pool = net.reservoirs.reduce((s, r) => s + r.water, 0)
    if (pool > 0) return
    const needy = plots.filter((p) =>
      net.plotIds.has(p.id) && p.crop_id && p.water < Math.min(60, targetOf(p))).length
    if (needy) logs.push(`⚠️ 网络#${idx + 1} 蓄水池干涸断流，${needy} 块地缺水，等待降雨补水`)
  })
  return logs
}
