<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { pluginApi, type PluginInfo } from '../api/index.ts'

const list = ref<PluginInfo[]>([])
const versions = ref<Record<string, string[]>>({})
const error = ref('')
const notice = ref('')
const busy = ref('')

async function load() {
  try {
    list.value = await pluginApi.list()
    versions.value = (await pluginApi.versions()).versions
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function act(code: string, what: 'reload' | 'rollback' | 'disable' | 'unload') {
  busy.value = `${code}:${what}`
  error.value = ''
  notice.value = ''
  try {
    const r = await pluginApi[what](code)
    notice.value = `${code} ${what} → ${'version' in r ? `${r.version}（generation ${r.generation}）` : r.state}`
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

async function reloadAll() {
  busy.value = 'all'
  error.value = ''
  try {
    const rs = await pluginApi.reloadAll()
    notice.value = `已换代 ${rs.length} 个：${rs.map((r) => `${r.code}@${r.version}`).join('，')}`
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

let timer: number | undefined
onMounted(() => {
  void load()
  // 热更新是运行期事实，页面就该跟着动（5 秒轮询，不做假实时）
  timer = window.setInterval(() => void load(), 5000)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="card">
    <div class="row" style="justify-content: space-between">
      <h1>源插件</h1>
      <div class="row">
        <button class="btn" :disabled="!!busy" @click="reloadAll">
          {{ busy === 'all' ? '换代中…' : '全部 reload' }}
        </button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>
    <p class="muted">
      插件 = <code>plugins/&lt;code&gt;/&lt;version&gt;/</code>。reload 换到最新版本，rollback 回上一代，
      disable 只翻状态（历史行保留），unload 摘注册表。<strong>全程不重启进程</strong>；
      在飞请求会在换代时被等完（drain）。
    </p>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="notice" class="muted">{{ notice }}</p>
    <table v-if="list.length">
      <thead>
        <tr>
          <th>源码</th><th>版本</th><th>状态</th><th>隔离</th><th>generation</th><th>在飞</th><th>可用版本</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in list" :key="p.code">
          <td class="mono">{{ p.code }}</td>
          <td class="mono">{{ p.version }}</td>
          <td>
            <span class="tag" :class="p.state === 'active' ? 'ok' : p.state === 'failed' ? 'bad' : 'warn'">{{ p.state }}</span>
            <div v-if="p.last_error" class="err mono" style="margin-top: 4px">{{ p.last_error }}</div>
          </td>
          <td>{{ p.isolation }}</td>
          <td class="mono">{{ p.generation }}</td>
          <td class="mono">{{ p.inflight }}</td>
          <td class="mono">{{ (versions[p.code] || []).join(' → ') || '—' }}</td>
          <td>
            <div class="row">
              <button class="btn" :disabled="!!busy" @click="act(p.code, 'reload')">reload</button>
              <button class="btn warn" :disabled="!!busy" @click="act(p.code, 'rollback')">rollback</button>
              <button class="btn warn" :disabled="!!busy" @click="act(p.code, 'disable')">disable</button>
              <button class="btn danger" :disabled="!!busy" @click="act(p.code, 'unload')">unload</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">插件目录为空。打包一个：<code>node tools/pack-plugin.mjs fq_novel</code></p>
  </div>
</template>
