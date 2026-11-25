<template>
  <div>
    <PageHeader
      title="源插件"
      subtitle="插件源码位于 plugins/<源码>/（单版本，manifest 里带 version）；reload 换代、disable/enable 翻状态、unload 摘注册后可再注册。多版本由开发者在外部维护。"
    />

    <div class="reveal flex flex-wrap items-center gap-4 mb-6">
      <button @click="load" class="btn-ghost btn-sm">刷新</button>
      <button @click="installOpen = !installOpen" class="btn-primary btn-sm">{{ installOpen ? '取消添加' : '添加插件' }}</button>
      <button @click="reloadAll" class="btn-ghost btn-sm" :disabled="busy === 'all'">
        {{ busy === 'all' ? '换代中…' : '全部 reload' }}
      </button>
      <label class="text-sm text-text-muted flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" v-model="autoRefresh" /> 每 5 秒自动刷新
      </label>
      <span v-if="notice" class="text-xs text-text-muted">{{ notice }}</span>
    </div>

    <!-- 添加插件：唯一入口是上传 zip（manifest + index.mjs 都在包里，不用手贴文本）。
         安装 = 允许在进程内执行任意代码，所以只有管理员能进来。 -->
    <!-- 这里**不能**带 .reveal：reveal 靠 IntersectionObserver 在 load() 之后统一观察，
         动态插入的节点没人观察 → 永远停在 opacity:0（点了"添加插件"像没反应，
         得点刷新触发下一轮 load() 才出现）。 -->
    <section v-if="installOpen" class="card mb-6">
      <h2 class="font-serif text-lg font-medium tracking-tight mb-4">添加插件</h2>
      <!-- 上传插件包（zip）：包根或 <源码>/ 一层都可以，版本从 manifest 读 -->
      <div class="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-border">
        <label class="flex flex-col gap-1 text-xs text-text-muted">插件包（.zip）
          <input type="file" accept=".zip,application/zip" class="input text-xs" @change="onZip" />
        </label>
        <button class="btn-primary btn-sm" :disabled="installing || !zipFile" @click="installZip">
          {{ installing ? '安装中…' : '上传并安装' }}
        </button>
        <span v-if="zipFile" class="text-xs text-text-muted">{{ zipFile.name }} · {{ Math.round(zipFile.size / 1024) }} KB</span>
      </div>

      <div class="text-xs text-text-muted">
        包里带 manifest.json（含 version）与 index.mjs，版本从 manifest 读，不用手填。
      </div>
    </section>

    <UiSpinner v-if="loading" />
    <UiEmpty v-else-if="error" title="加载失败" :text="error" />
    <UiEmpty
      v-else-if="plugins.length === 0"
      title="暂无插件"
      text="插件目录为空：把开发者提供的插件包（zip）用「添加插件」上传即可。"
    />

    <div v-else class="table-wrap reveal">
      <table class="table-base">
        <thead>
          <tr>
            <th>源码</th><th>版本</th><th>状态</th><th>隔离</th>
            <th title="全局限代序号：本次进程里第几次加载（跨源单调递增，用于区分在飞请求属于哪一代）">世代</th>
            <th title="这个源本进程内成功加载的次数（reload/重装都算）">加载</th>
            <th>在飞</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in plugins" :key="p.code">
            <td class="font-mono text-xs">{{ p.code }}</td>
            <td class="font-mono text-xs">{{ p.version }}</td>
            <td>
              <UiTag :tone="stateTone(p.state)" :label="stateLabel(p.state)" />
              <div v-if="p.last_error" class="text-xs text-danger mt-1 break-all">{{ p.last_error }}</div>
            </td>
            <td class="text-xs text-text-muted">{{ p.isolation }}</td>
            <td class="font-mono text-xs">{{ p.generation }}</td>
            <td class="font-mono text-xs text-text-muted">{{ p.loads ?? 0 }}</td>
            <td class="font-mono text-xs">{{ p.inflight }}</td>
            <td class="whitespace-nowrap">
              <div class="flex items-center gap-1.5 text-xs" style="white-space: nowrap">
                <template v-for="(op, i) in opsFor(p)" :key="op.method">
                  <span v-if="i" class="text-border select-none">|</span>
                  <button :disabled="!!busy" @click="act(p.code, op.method)"
                    :class="op.danger ? 'text-pale-red-fg hover:opacity-70 transition-opacity' : 'text-text-muted hover:text-text transition-colors'">{{ op.label }}</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import PageHeader from '../../components/PageHeader.vue'
import UiSpinner from '../../components/UiSpinner.vue'
import UiEmpty from '../../components/UiEmpty.vue'
import UiTag from '../../components/UiTag.vue'
import { adminApi } from '../../api/index.js'
import { toast, revealObserve } from '../../utils.js'

const plugins = ref([])
const installOpen = ref(false)
const installing = ref(false)
const zipFile = ref(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const busy = ref('')
const autoRefresh = ref(true)
let timer = null

const stateTone = (s) => (s === 'active' ? 'green' : s === 'failed' ? 'red' : 'gray')
const stateLabel = (s) => ({ active: '生效中', failed: '加载失败', disabled: '已禁用', unloaded: '未注册' }[s] || s)

// 与「用户管理」操作栏一致：文字按钮 + 竖线分隔，危险操作用红色。
const opsFor = (p) => {
  const ops = []
  if (p.state === 'disabled') ops.push({ label: '启用', method: 'enablePlugin' })
  if (p.state === 'unloaded') ops.push({ label: '注册', method: 'registerPlugin' })
  else ops.push({ label: 'reload', method: 'reloadPlugin' })
  if (p.state === 'active' || p.state === 'failed') ops.push({ label: '禁用', method: 'disablePlugin' })
  if (p.state !== 'unloaded') ops.push({ label: 'unload', method: 'unloadPlugin', danger: true })
  return ops
}

const load = async () => {
  loading.value = plugins.value.length === 0
  try {
    const [registered, available] = await Promise.all([adminApi.listPlugins(), adminApi.availablePlugins()])
    // unload 只摘注册表、不删源码：把磁盘上还没注册的目录也列出来，给「注册」按钮一个入口
    const known = new Set(registered.map((p) => p.code))
    plugins.value = [
      ...registered,
      ...available.filter((code) => !known.has(code)).map((code) => ({
        code, version: '—', state: 'unloaded', isolation: '—', generation: 0, loads: 0, inflight: 0,
      })),
    ]
    error.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
    nextTick(revealObserve)
  }
}

const act = async (code, method) => {
  busy.value = code + ':' + method
  notice.value = ''
  try {
    const r = await adminApi[method](code)
    notice.value = r.version ? `${code} → ${r.version}（世代 ${r.generation}）` : `${code} → ${r.state}`
    toast('已生效', 'success')
    await load()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}

const reloadAll = async () => {
  busy.value = 'all'
  notice.value = ''
  try {
    const rs = await adminApi.reloadAllPlugins()
    notice.value = `换代 ${rs.length} 个：${rs.map((r) => `${r.code}@${r.version}`).join('，')}`
    toast('已全部换代', 'success')
    await load()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}

const onZip = (e) => {
  zipFile.value = e.target.files?.[0] ?? null
}

const installZip = async () => {
  if (!zipFile.value) return
  installing.value = true
  try {
    const buf = new Uint8Array(await zipFile.value.arrayBuffer())
    // FileReader 的 dataURL 里带前缀；这里直接转 base64（≤16MB 的包用一次循环足够）
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    const r = await adminApi.installPluginPackage({ packageBase64: btoa(bin) })
    notice.value = `已安装 ${r.code}@${r.version}（世代 ${r.generation}）`
    toast('已安装并生效', 'success')
    installOpen.value = false
    zipFile.value = null
    await load()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  load()
  timer = setInterval(() => {
    if (autoRefresh.value) load()
  }, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
// 关闭自动刷新时手动点刷新即可；打开时不重复建定时器
watch(autoRefresh, () => {})
// 展开"添加插件"时补一次观察：区块里若带 .reveal，只有被观察过才会加 .in（否则永远 opacity:0）
watch(installOpen, () => {
  if (installOpen.value) nextTick(revealObserve)
})
</script>
