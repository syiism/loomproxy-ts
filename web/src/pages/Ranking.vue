<template>
  <div>
    <PageHeader title="排行榜" subtitle="站内搜索热词与在读书目排名，取自接口调用明细的内容维度（只统计窗口内的真实调用）。">
      <template #actions>
        <!-- 三个 w-auto 的下拉并排是 398px，比 390 视口还宽：窄屏必须允许换行（待办清单 P65） -->
        <div class="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
          <select v-model="media" class="input font-mono text-sm w-auto" @change="load">
            <option value="">全部媒介</option>
            <option v-for="o in medias" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <select v-model="source" class="input font-mono text-sm w-auto" @change="load">
            <option value="">全部数据源</option>
            <option v-for="o in sources" :key="o.code" :value="o.code">{{ o.name }}</option>
          </select>
          <select v-model.number="days" class="input font-mono text-sm w-auto" @change="load">
            <option :value="1">今天</option>
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
          </select>
        </div>
      </template>
    </PageHeader>

    <UiSpinner v-if="loading" />
    <UiEmpty v-else-if="denied" title="榜单未开放" text="管理员尚未在「系统设置 · 站点」的「可见榜单的数据源」里勾选任何数据源。" />
    <UiEmpty v-else-if="error" title="加载失败" :text="error" />

    <div v-else-if="boards.length" class="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 items-start">
      <section v-for="b in boards" :key="b.dim" class="card reveal">
        <div class="flex items-baseline justify-between gap-3 mb-4">
          <div class="font-serif text-lg font-medium tracking-tight">{{ b.title }}</div>
          <div class="font-mono text-xs text-text-muted">{{ b.metric }} · {{ b.rows.length }} 项</div>
        </div>

        <UiEmpty v-if="b.rows.length === 0" title="窗口内没有数据" :text="b.emptyHint" />
        <ol v-else class="divide-y divide-border">
          <li v-for="(it, i) in b.rows" :key="it.name" class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span class="w-6 shrink-0 font-mono text-xs" :class="i < 3 ? 'text-text' : 'text-text-muted'">{{ i + 1 }}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm" :title="it.name">{{ it.name }}</div>
            </div>
            <span class="shrink-0 font-serif text-lg tracking-tight">{{ it.total }}</span>
            <span class="w-4 shrink-0 font-mono text-xs text-text-muted">{{ b.unit }}</span>
          </li>
        </ol>
      </section>
    </div>

    <p v-if="!loading && !error && !denied && hasRows" class="mt-5 text-xs leading-relaxed text-text-muted">
      口径：两榜数字不同义——阅读榜按「访问人数」（同源自内去重、匿名按 IP），只统计正文接口；
      搜索热词榜按「搜索次数」。同名条目按数据源分开、「全部数据源」才跨源合并；多形态源用「全部媒介」切开，
      未判定媒介不计入。名称靠缓存反查，无映射的正文条目不入榜。公开范围由管理员在「系统设置 · 站点」决定。
    </p>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import UiSpinner from '../components/UiSpinner.vue'
import UiEmpty from '../components/UiEmpty.vue'
import { adminApi } from '../api/index.js'
import { revealObserve } from '../utils.js'

const EMPTY_HINTS = {
  keyword: '窗口内没有任何搜索请求留下搜索词。',
  book: '窗口内没有留下书名的正文调用（只统计正文接口，打开书目与翻目录都不计入）。',
}
const loading = ref(true)
const error = ref('')
const denied = ref(false)
const days = ref(7)
const source = ref('')
const sources = ref([])
const media = ref('')
const medias = ref([])
const boards = ref([])
// 底部那段口径说明只在该说的时候说：各榜全空（新窗口、刚重启、筛到没数据的源）时页面只剩空态组件，
// 三百字的使用手册挂在一片空白下面就是噪声。判据必须是「有没有数据行」，不是「后端有没有回榜单定义」。
const hasRows = computed(() => boards.value.some(b => (b.rows || []).length))

const load = async () => {
  loading.value = true
  error.value = ''
  denied.value = false
  try {
    // 公开榜端点：只回聚合的名称与次数，与管理员用的 /admin/monitor/subjects 错开
    const data = await adminApi.rankBoards({ days: days.value, source: source.value, media: media.value })
    sources.value = data.sources || []
    medias.value = data.medias || []
    boards.value = (data.boards || []).map(b => ({
      ...b,
      emptyHint: EMPTY_HINTS[b.dim] || '窗口内没有数据。',
    }))
  } catch (e) {
    // 400（source 已不在启用列表、或 media 不在枚举里）时清掉筛选条件重拉全量，避免卡在空榜
    if (e.status === 400 && (source.value || media.value)) {
      source.value = ''
      media.value = ''
      return load()
    }
    if (e.status === 403) denied.value = true
    else error.value = e.message
  } finally {
    loading.value = false
    // 必须在 loading 落回 false 之后再观察：卡片的 .reveal 此刻才存在于 DOM，
    // 而 revealObserve 只观察调用时已存在的 .reveal:not(.in)，观察不到就永远停在 opacity:0
    nextTick(revealObserve)
  }
}

// 榜单是实时聚合，且名称反查依赖进程内缓存（重启即空）——
// 切回标签页时主动刷一次，否则看到的是上次进入时的快照
const onVisible = () => { if (document.visibilityState === 'visible' && !loading.value) load() }
onMounted(() => { load(); document.addEventListener('visibilitychange', onVisible) })
onUnmounted(() => document.removeEventListener('visibilitychange', onVisible))
</script>
