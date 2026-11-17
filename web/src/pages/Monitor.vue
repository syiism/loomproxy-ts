<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { monitorApi, type CallLogRow } from '../api/index.ts'

const rows = ref<CallLogRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const error = ref('')
const loading = ref(false)

// plugin_version 是 ④ §7 批准的那一格：热更新后要能回答"换成新版本之后错误率变了吗"
const filters = ref({ source: '', pluginVersion: '', inBandCode: '', mediaType: '', keyword: '' })

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await monitorApi.history({ page: page.value, pageSize: pageSize.value, ...filters.value })
    rows.value = data.list
    total.value = data.total
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function reset() {
  filters.value = { source: '', pluginVersion: '', inBandCode: '', mediaType: '', keyword: '' }
  page.value = 1
  await load()
}

function go(delta: number) {
  const next = page.value + delta
  if (next < 1 || (next - 1) * pageSize.value >= total.value) return
  page.value = next
  void load()
}

function statusClass(r: CallLogRow): string {
  if (r.status >= 500) return 'bad'
  if (r.status >= 400 || r.in_band_error) return 'warn'
  return 'ok'
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="row" style="justify-content: space-between">
      <h1>调用明细</h1>
      <span class="muted">共 {{ total }} 行</span>
    </div>
    <p class="muted">
      一行一次数据面请求（含 4xx/5xx 与带内失败）。<code>plugin_version</code> 让你能按插件版本切分读数——
      换代之后哪一档变坏了，看这一列。
    </p>
    <div class="row" style="margin-bottom: 12px">
      <input v-model="filters.source" placeholder="源码 fq_novel" @keyup.enter="page = 1; load()" />
      <input v-model="filters.pluginVersion" placeholder="插件版本 0.1.0" @keyup.enter="page = 1; load()" />
      <input v-model="filters.inBandCode" placeholder="带内业务码" @keyup.enter="page = 1; load()" />
      <select v-model="filters.mediaType" @change="page = 1; load()">
        <option value="">全部媒介</option>
        <option value="novel">novel</option>
        <option value="audio">audio</option>
        <option value="comic">comic</option>
        <option value="video">video</option>
      </select>
      <input v-model="filters.keyword" placeholder="搜索词包含" @keyup.enter="page = 1; load()" />
      <button class="btn" :disabled="loading" @click="page = 1; load()">{{ loading ? '查询中…' : '查询' }}</button>
      <button class="btn" @click="reset">重置</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <table v-if="rows.length">
      <thead>
        <tr>
          <th>时间</th><th>源/动作</th><th>版本</th><th>状态</th><th>耗时</th>
          <th>用户</th><th>内容维度</th><th>条数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td class="mono">{{ r.created_at.replace('T', ' ').slice(0, 19) }}</td>
          <td class="mono">{{ r.source }}/{{ r.action }}</td>
          <td class="mono">{{ r.plugin_version || '—' }}</td>
          <td>
            <span class="tag" :class="statusClass(r)">{{ r.status }}</span>
            <span v-if="r.in_band_error" class="tag warn" style="margin-left: 6px">
              带内{{ r.in_band_code ? ` ${r.in_band_code}` : '' }}
            </span>
          </td>
          <td class="mono">{{ r.latency_ms }}ms</td>
          <td>{{ r.username }}</td>
          <td>
            <div v-if="r.content_withheld" class="muted">（用户关闭留存）</div>
            <div v-else class="mono" style="white-space: pre-wrap">
              {{ [r.keyword && `词:${r.keyword}`, r.book_name && `书:${r.book_name}`, r.chapter_title && `章:${r.chapter_title}`]
                .filter(Boolean).join('  ') || '—' }}
            </div>
          </td>
          <td class="mono">{{ r.result_count }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading" class="muted">没有命中。明细是内存环形（本轮上限 5000 行）。</p>
    <div class="pager">
      <button class="btn" :disabled="page <= 1" @click="go(-1)">上一页</button>
      <span class="muted">第 {{ page }} 页</span>
      <button class="btn" :disabled="page * pageSize >= total" @click="go(1)">下一页</button>
    </div>
  </div>
</template>
