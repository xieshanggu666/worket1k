<template>
  <div class="panel irr-panel">
    <h3>💧 灌溉系统</h3>

    <!-- 建造 -->
    <div class="build-row">
      <button class="build-btn" :class="{on: store.irrBuildMode==='reservoir'}" @click="store.setIrrBuildMode('reservoir')">
        🛢️ 蓄水池 <span class="cost">🪙{{ store.irrigationCosts.reservoir }}</span>
      </button>
      <button class="build-btn" :class="{on: store.irrBuildMode==='canal'}" @click="store.setIrrBuildMode('canal')">
        ➖ 水渠 <span class="cost">🪙{{ store.irrigationCosts.canal }}/段</span>
      </button>
    </div>
    <p class="hint" v-if="store.irrBuildMode">
      点击地图空地放置{{ store.irrBuildMode === 'reservoir' ? '蓄水池' : '水渠（可连续铺设）' }}，再次点击按钮取消
    </p>
    <p class="hint" v-else>蓄水池储水，水渠连接蓄水池与耕地；每日结算时自动为连通地块浇水</p>

    <div class="divider"></div>

    <!-- 供水概览 -->
    <div class="net-row">
      <span>🛢️ 总储量 <b>{{ totalWater }}/{{ totalCap }}</b></span>
      <span>🌾 供水地块 <b :class="{warn: irrigatedCount < plantedCount}">{{ irrigatedCount }}/{{ plantedCount }}</b></span>
    </div>
    <div class="bar total"><i :style="{width: totalCap ? (totalWater/totalCap*100)+'%' : '0%'}"></i></div>

    <!-- 供水网络：同一网络多池统一分水 -->
    <div class="nets" v-if="store.irrigationNets.length">
      <div class="net" v-for="n in store.irrigationNets" :key="n.id" :class="{short: n.demand > n.water}">
        <div class="net-head">
          <b>🕸️ 网络#{{ n.id }}</b>
          <span>🛢️×{{ n.reservoirs }}</span>
          <span>💧 {{ n.water }}/{{ n.cap }}</span>
          <span>🌾 {{ n.plots }} 块地</span>
        </div>
        <div class="net-sub">
          <span>今日需水 {{ n.demand }}</span>
          <span>日耗约 {{ n.dailyUse }}</span>
          <span v-if="n.dailyUse > 0">可维持 {{ Math.floor(n.water / n.dailyUse) }} 天</span>
          <em v-if="n.demand > n.water" class="lack">缺口 {{ n.demand - n.water }}</em>
          <em v-else class="enough">供水充足</em>
        </div>
      </div>
    </div>

    <!-- 最近一天分配结果：缺水时逐地块展示需水/实供 -->
    <div class="alloc" v-if="store.irrigationAlloc.rows.length">
      <div class="alloc-head">
        📋 最近分配结果
        <em :class="shortCount ? 'lack' : 'enough'">{{ shortCount ? `水量不足 · ${shortCount} 块未浇足` : '全部浇足' }}</em>
      </div>
      <div class="alloc-list">
        <div class="alloc-row" v-for="a in store.irrigationAlloc.rows" :key="a.plot_id"
             :class="{miss: a.given <= 0, part: a.given > 0 && a.given < a.need}">
          <span class="a-plot">地块({{ a.x }},{{ a.y }})<i>#{{ a.net }}</i></span>
          <span class="a-need">需 {{ a.need }}</span>
          <span class="a-give">{{ a.given <= 0 ? '🚱 未供水' : a.given < a.need ? `⚠️ 仅供 ${a.given}` : `✅ 供 ${a.given}` }}</span>
        </div>
      </div>
    </div>

    <!-- 设施列表 -->
    <div class="fac-list" v-if="store.irrigation.length">
      <div class="fac" v-for="f in sortedFacilities" :key="f.id" :class="{off: !f.active}">
        <span class="f-icon">{{ f.kind === 'reservoir' ? '🛢️' : '➖' }}</span>
        <div class="f-info">
          <b>{{ f.kind === 'reservoir' ? '蓄水池' : '水渠' }} ({{ f.x }},{{ f.y }})</b>
          <div class="bar" v-if="f.kind === 'reservoir'">
            <i :style="{width: (f.water / f.cap * 100) + '%'}"></i>
          </div>
          <span class="f-state" :class="stateClass(f)">{{ stateText(f) }}</span>
        </div>
        <button class="mini" @click="store.toggleIrrigation(f.id)">{{ f.active ? '停用' : '启用' }}</button>
        <button class="mini red" @click="demolish(f)">拆除</button>
      </div>
    </div>
    <div class="none" v-else>还没有灌溉设施，先建一座蓄水池吧</div>

    <p class="hint rules">
      规则：每日结算时，同一连通网络内的多座蓄水池水量打通、统一分水；
      按地块「保水优先级 高→低」供水，每块地浇到其「目标水分」即止（目标 0 = 不浇水）；
      降雨为蓄水池补水，干旱加速蒸发，品种耗水（如抗旱减半）计入日耗估算；
      停用/拆除即断流并重算网络，重新启用或重建后自动恢复；缺水时上方列出逐地块分配结果。
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()

const sortedFacilities = computed(() =>
  [...store.irrigation].sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind === 'reservoir' ? -1 : 1))
)
const reservoirs = computed(() => store.irrigation.filter((f) => f.kind === 'reservoir'))
const totalWater = computed(() => reservoirs.value.reduce((s, f) => s + f.water, 0))
const totalCap = computed(() => reservoirs.value.reduce((s, f) => s + (f.cap || 0), 0))
const irrigatedCount = computed(() => store.plots.filter((p) => p.crop_id && p.irrigated).length)
const plantedCount = computed(() => store.plots.filter((p) => p.crop_id).length)
const shortCount = computed(() => store.irrigationAlloc.rows.filter((a) => a.given < a.need).length)

function stateText(f) {
  if (!f.active) return '已停用 · 断流'
  if (f.kind === 'reservoir') return f.water > 0 ? `💧 ${Math.round(f.water)}/${f.cap}` : '干涸 · 等待降雨'
  return f.linked ? '通水中' : '未连通蓄水池'
}
function stateClass(f) {
  if (!f.active) return 'off'
  if (f.kind === 'reservoir') return f.water > 0 ? 'ok' : 'warn'
  return f.linked ? 'ok' : 'warn'
}
function demolish(f) {
  const tip = f.kind === 'reservoir' && f.water > 0 ? `，池内 ${Math.round(f.water)} 水量将作废` : ''
  if (confirm(`确定拆除${f.kind === 'reservoir' ? '蓄水池' : '水渠'} (${f.x},${f.y}) 吗${tip}？`)) {
    store.demolishIrrigation(f.id)
  }
}
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
h3 { margin:0 0 10px;color:#fff;font-size:15px; }
.build-row { display:flex;gap:8px; }
.build-btn {
  flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.25);border-radius:9px;
  padding:10px;color:#dbe4f3;cursor:pointer;font-size:12px;display:flex;flex-direction:column;gap:4px;align-items:center;
}
.build-btn.on { border-color:#29b6f6;box-shadow:0 0 0 1px #29b6f6;background:#12314f; }
.cost { color:#ffc107;font-size:11px; }
.hint { color:#8ba2c8;font-size:11px;margin:8px 0 0;line-height:1.5; }
.hint.rules { color:#5b6f94;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.net-row { display:flex;justify-content:space-between;font-size:12px;color:#c6d2e6;margin-bottom:5px; }
.net-row b { color:#4fc3f7; }
.net-row b.warn { color:#ef9a9a; }
.bar { height:8px;background:#0c1730;border-radius:4px;overflow:hidden; }
.bar i { display:block;height:100%;background:linear-gradient(90deg,#0288d1,#4fc3f7);border-radius:4px; }
.bar.total { margin-bottom:10px; }
.nets { display:flex;flex-direction:column;gap:6px;margin-bottom:10px; }
.net { background:#122240;border:1px solid rgba(120,160,220,0.15);border-radius:8px;padding:7px 9px; }
.net.short { border-color:rgba(239,83,80,0.4); }
.net-head { display:flex;gap:8px;align-items:center;font-size:11px;color:#c6d2e6;flex-wrap:wrap; }
.net-head b { color:#4fc3f7;font-size:12px; }
.net-sub { display:flex;gap:8px;align-items:center;font-size:10px;color:#6f84ab;margin-top:3px;flex-wrap:wrap; }
.net-sub em, .alloc-head em { font-style:normal;padding:1px 6px;border-radius:4px; }
.lack { color:#ef9a9a;background:#3a1f1f; }
.enough { color:#a5d6a7;background:#1b3a21; }
.alloc { margin-bottom:10px; }
.alloc-head { display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#c6d2e6;margin-bottom:5px; }
.alloc-list { max-height:130px;overflow-y:auto; }
.alloc-row { display:flex;align-items:center;gap:6px;font-size:11px;color:#8ba2c8;padding:3px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.alloc-row:last-child { border-bottom:none; }
.alloc-row.miss { color:#ef9a9a; }
.alloc-row.part { color:#ffb74d; }
.a-plot { flex:1; }
.a-plot i { font-style:normal;color:#4fc3f7;font-size:9px;margin-left:3px; }
.a-need { color:#6f84ab; }
.fac-list { max-height:220px;overflow-y:auto; }
.fac { display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.fac:last-child { border-bottom:none; }
.fac.off { opacity:.6; }
.f-icon { font-size:18px;width:26px;text-align:center; }
.f-info { flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center; }
.f-info b { color:#e8eefb;font-size:12px;width:100%; }
.f-info .bar { flex:1;min-width:60px; }
.f-state { font-size:10px;padding:2px 6px;border-radius:4px;background:#16263f;color:#8ba2c8;white-space:nowrap; }
.f-state.ok { color:#a5d6a7;background:#1b3a21; }
.f-state.warn { color:#ffb74d;background:#3a2a12; }
.f-state.off { color:#8ba2c8;background:#23304a; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:5px 9px;font-size:11px;cursor:pointer;white-space:nowrap; }
.mini.red { background:#c62828; }
.mini:hover { filter:brightness(1.15); }
.none { color:#5b6f94;text-align:center;padding:14px;font-size:12px; }
</style>
