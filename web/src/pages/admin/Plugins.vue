<template>
  <div>
    <PageHeader
      title="源插件"
      subtitle="插件包位于 plugins/<源码>/<版本>/；reload 换代、rollback 回退、disable 翻状态、unload 摘注册，均不重启进程。"
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

    <!-- 添加插件：主路径是上传 zip 插件包；手工提交（manifest + 入口文本）收在次级开关里，
         只给"一个文件的小源"用。安装 = 允许在进程内执行任意代码，所以只有管理员能进来；
         同名版本已存在会被拒（不覆盖正在跑的产物）。 -->
    <!-- 这里**不能**带 .reveal：reveal 靠 IntersectionObserver 在 load() 之后统一观察，
         动态插入的节点没人观察 → 永远停在 opacity:0（点了"添加插件"像没反应，
         得点刷新触发下一轮 load() 才出现）。 -->
    <section v-if="installOpen" class="card mb-6">
      <h2 class="font-serif text-lg font-medium tracking-tight mb-4">添加插件</h2>
      <!-- 上传插件包（zip）：包里可以是包根，也可以是 <源码>/<版本>/ 一层（zip -r 打包目录的产物） -->
      <div class="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-border">
        <label class="flex flex-col gap-1 text-xs text-text-muted">插件包（.zip）
          <input type="file" accept=".zip,application/zip" class="input text-xs" @change="onZip" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-muted">版本（可留空：包里有 <源码>/<版本>/ 目录时自动取）
          <input v-model="zipVersion" class="input font-mono w-32" placeholder="0.1.0" maxlength="32">
        </label>
        <button class="btn-primary btn-sm" :disabled="installing || !zipFile" @click="installZip">
          {{ installing ? '安装中…' : '上传并安装' }}
        </button>
        <span v-if="zipFile" class="text-xs text-text-muted">{{ zipFile.name }} · {{ Math.round(zipFile.size / 1024) }} KB</span>
      </div>

      <div class="flex flex-wrap items-center gap-3 mb-3">
        <span class="text-xs text-text-muted flex-1 min-w-56">打包上传是主路径：<span class="font-mono">zip -r pkg.zip &lt;源码&gt;</span> 后选文件即可（包里可含 data/*.json 等数据文件）。</span>
        <button class="btn-ghost btn-sm" @click="pasteOpen = !pasteOpen">{{ pasteOpen ? '收起手工提交' : '或手工提交文件内容' }}</button>
      </div>

      <div v-if="pasteOpen" class="flex flex-wrap items-end gap-3 mb-3 pt-3 border-t border-border">
        <label class="flex flex-col gap-1 text-xs text-text-muted">源码
          <input v-model="form.code" class="input font-mono w-40" placeholder="my_novel" maxlength="64">
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-muted">版本
          <input v-model="form.version" class="input font-mono w-28" placeholder="0.1.0" maxlength="32">
        </label>
        <span class="text-xs text-text-muted">写进 plugins/&lt;源码&gt;/&lt;版本&gt;/，装好立即生效（reload）</span>
      </div>
      <div v-if="pasteOpen" class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-xs text-text-muted">manifest.json
          <textarea v-model="form.manifest" class="input font-mono text-xs h-56" spellcheck="false" placeholder='{"sdk_version":"^1","entry":"./index.mjs","params":{"search":["query"]},"meta":{"code":"my_novel","display":"我的源","category":"demo","actions":["search"]}}'></textarea>
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-muted">入口文件内容（默认 index.mjs）
          <input v-model="form.entryName" class="input font-mono text-xs mb-1" placeholder="index.mjs" maxlength="128">
          <textarea v-model="form.entry" class="input font-mono text-xs h-56" spellcheck="false" placeholder="export default { handlers: { search: async (ctx) => ({ bookList: [] }) } }"></textarea>
        </label>
      </div>
      <div v-if="pasteOpen" class="flex items-center gap-3 mt-4">
        <button class="btn-primary btn-sm" :disabled="installing" @click="install">{{ installing ? '安装中…' : '安装并生效' }}</button>
        <span class="text-xs text-text-muted">安装失败会把刚写入的目录清掉（不留带病的版本）；已存在同名版本会被拒。</span>
      </div>
    </section>

    <UiSpinner v-if="loading" />
    <UiEmpty v-else-if="error" title="加载失败" :text="error" />
    <UiEmpty
      v-else-if="plugins.length === 0"
      title="暂无插件"
      text="插件目录为空。打包一个：node tools/pack-plugin.mjs <源码>（产物落在 plugins/<源码>/<版本>/）"
    />

    <div v-else class="table-wrap reveal">
      <table class="table-base">
        <thead>
          <tr>
            <th>源码</th><th>版本</th><th>状态</th><th>隔离</th>
            <th title="全局限代序号：本次进程里第几次加载（跨源单调递增，用于区分在飞请求属于哪一代）">世代</th>
            <th title="这个源本进程内成功加载的次数（reload/回滚/重装都算）">加载</th>
            <th>在飞</th><th>可用版本</th><th>操作</th>
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
            <td class="font-mono text-xs text-text-muted">{{ (versions[p.code] || []).join(' → ') || '—' }}</td>
            <td>
              <div class="flex flex-wrap gap-1.5">
                <button class="btn-ghost btn-xs" :disabled="!!busy" @click="act(p.code, 'reloadPlugin')">reload</button>
                <button class="btn-ghost btn-xs" :disabled="!!busy" @click="act(p.code, 'rollbackPlugin')">rollback</button>
                <button class="btn-ghost btn-xs" :disabled="!!busy" @click="act(p.code, 'disablePlugin')">disable</button>
                <button class="btn-ghost btn-xs" :disabled="!!busy" @click="act(p.code, 'unloadPlugin')">unload</button>
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
const zipVersion = ref('')
const pasteOpen = ref(false)
const form = ref({ code: '', version: '0.1.0', entryName: 'index.mjs', manifest: '', entry: '' })
const versions = ref({})
const loading = ref(false)
const error = ref('')
const notice = ref('')
const busy = ref('')
const autoRefresh = ref(true)
let timer = null

const stateTone = (s) => (s === 'active' ? 'green' : s === 'failed' ? 'red' : 'gray')
const stateLabel = (s) => ({ active: '生效中', failed: '加载失败', disabled: '已禁用' }[s] || s)

const load = async () => {
  loading.value = plugins.value.length === 0
  try {
    plugins.value = await adminApi.listPlugins()
    versions.value = (await adminApi.listPluginVersions()).versions || {}
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
    const r = await adminApi.installPluginPackage({ packageBase64: btoa(bin), version: zipVersion.value.trim() || undefined })
    notice.value = `已安装 ${r.code}@${r.version}（世代 ${r.generation}）`
    toast('已安装并生效', 'success')
    installOpen.value = false
    zipFile.value = null
    zipVersion.value = ''
    await load()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    installing.value = false
  }
}

const install = async () => {
  installing.value = true
  notice.value = ''
  try {
    const code = form.value.code.trim()
    const version = form.value.version.trim()
    const entryName = (form.value.entryName || 'index.mjs').trim().replace(/^\.\//, '')
    const files = { 'manifest.json': form.value.manifest, [entryName]: form.value.entry }
    const r = await adminApi.installPlugin({ code, version, files })
    notice.value = `已安装 ${r.code}@${r.version}（世代 ${r.generation}）`
    toast('已安装并生效', 'success')
    installOpen.value = false
    form.value = { code: '', version: '0.1.0', entryName: 'index.mjs', manifest: '', entry: '' }
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
