<template>
  <div>
    <PageHeader
      title="源插件"
      subtitle="数据源以插件包形式加载：plugins/<源码>/<版本>/。reload 换到最新版本、rollback 回上一代、disable 只翻状态（历史行保留）、unload 摘注册表——全程不重启进程；在飞请求会在换代时被等完。"
    />

    <div class="reveal flex flex-wrap items-center gap-4 mb-6">
      <button @click="load" class="btn-ghost btn-sm">刷新</button>
      <button @click="reloadAll" class="btn-ghost btn-sm" :disabled="busy === 'all'">
        {{ busy === 'all' ? '换代中…' : '全部 reload' }}
      </button>
      <label class="text-sm text-text-muted flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" v-model="autoRefresh" /> 每 5 秒自动刷新
      </label>
      <span v-if="notice" class="text-xs text-text-muted">{{ notice }}</span>
    </div>

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
            <th>源码</th><th>版本</th><th>状态</th><th>隔离</th><th>世代</th><th>在飞</th><th>可用版本</th><th>操作</th>
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
</script>
