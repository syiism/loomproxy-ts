<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { miscApi, type DatasourceItem } from '../api/index.ts'

const items = ref<DatasourceItem[]>([])
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = await miscApi.datasources()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="row" style="justify-content: space-between">
      <h1>数据源</h1>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>
    <p class="muted">
      <code>/datasources</code> 的按套餐裁剪视图。热加载后刷新本页即可见新源（进程不用重启）。
    </p>
    <p v-if="error" class="err">{{ error }}</p>
    <table v-if="items.length">
      <thead>
        <tr>
          <th>源码</th><th>名称</th><th>分类</th><th>媒介</th><th>搜索 tab</th><th>字典</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="it in items" :key="it.id">
          <td class="mono">{{ it.id }}</td>
          <td>{{ it.name }}</td>
          <td>{{ it.category }}</td>
          <td>{{ it.media_type || '—' }}</td>
          <td>
            <span v-for="t in it.search_tab" :key="t.tab_type" class="tag" style="margin-right: 6px">
              {{ t.name }}({{ t.tab_type }})
            </span>
          </td>
          <td class="mono">{{ it.files.join(', ') || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading" class="muted">还没有任何源：插件目录为空（<code>plugins/</code>）。</p>
  </div>
</template>
