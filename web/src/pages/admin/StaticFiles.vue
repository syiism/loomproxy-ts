<template>
  <div>
    <datalist id="static-sources"><option v-for="s in sources" :key="s.source" :value="s.source" /></datalist>
    <PageHeader title="静态文件" subtitle="管理 DATA_DIR 下的书源静态文件：分类字典、legado 书源、版本日志等；保存后立刻由 /data 对外提供。" />

    <div class="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-6 items-start reveal">
      <!-- 左侧文件树 -->
      <section class="card !p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border bg-surface-alt">
          <div class="font-medium text-sm mb-2">静态文件</div>
          <input v-model="filter" placeholder="筛选源 / 文件" class="input input-sm w-full" />
        </div>
        <UiSpinner v-if="loading" />
        <UiEmpty v-else-if="error" title="加载失败" :text="error" />
        <div v-else class="max-h-[60vh] overflow-y-auto divide-y divide-border">
          <div v-for="s in filteredSources" :key="s.source" class="px-3 py-2">
            <div class="flex items-center justify-between mb-1">
              <span class="font-mono text-xs text-text-muted">{{ s.source }}</span>
              <div class="flex items-center gap-2">
                <button class="text-[10px] text-text-muted hover:text-text" @click="startDirRename(s.source)">改名</button>
                <span class="font-mono text-xs text-text-muted">{{ s.file_count }}</span>
              </div>
            </div>
            <div v-if="renamingDir === s.source" class="flex items-center gap-1 mb-1">
              <input v-model="renameDirValue" class="input input-sm w-full font-mono" @keydown.enter="renameDir" />
              <button class="btn-primary btn-xs" @click="renameDir">确定</button>
              <button class="text-[10px] text-text-muted" @click="renamingDir = ''">取消</button>
            </div>
            <button v-for="f in s.files" :key="f.filename" @click="openFile(s.source, f)"
              class="w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors"
              :class="isCurrent(s.source, f) ? 'bg-surface-alt text-text' : 'text-text-muted hover:text-text hover:bg-surface-alt'">
              <span class="truncate flex-1 font-mono">{{ f.filename }}</span>
              <UiTag v-if="f.retired" tone="gray" label="已退役" />
              <UiTag v-else-if="f.category && f.category !== '其他'" tone="blue" :label="f.category" />
              <span v-if="!f.servable" class="text-[10px] text-text-muted" title="不是 .json，/data 不直接提供">·</span>
            </button>
          </div>
          <div v-if="!filteredSources.length" class="px-4 py-6 text-xs text-text-muted text-center">没有匹配的静态文件</div>
        </div>
        <div class="px-3 py-3 border-t border-border">
          <div class="text-xs text-text-muted mb-2">未建静态目录的源（可设置 data/&lt;source&gt;/ 目录名）</div>
          <div v-for="k in knownWithoutDir" :key="k.code" class="flex items-center gap-1 mb-1.5">
            <span class="text-xs font-mono truncate flex-1" :title="k.name">{{ k.code }}</span>
            <input v-model="pendingDir[k.code]" class="input input-sm w-24 font-mono" :placeholder="k.code" />
            <button class="btn-ghost btn-xs" @click="createDir(k.code)">建目录</button>
          </div>
          <div v-if="!knownWithoutDir.length" class="text-xs text-text-muted">全部已登记源都有静态目录</div>
        </div>
      </section>

      <!-- 右侧：上传表单在上、编辑器在下，同宽对齐 -->
      <div class="flex flex-col gap-6 min-w-0">
        <section class="card">
          <h2 class="font-medium text-sm mb-3">新增静态文件</h2>
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-xs text-text-muted">源名
              <input v-model="newSource" list="static-sources" class="input input-sm w-32 font-mono" placeholder="shuyuan" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-text-muted">文件名（含 .json）
              <input v-model="newFileName" class="input input-sm w-44 font-mono" placeholder="bookSource.json" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-text-muted">本地文件
              <input type="file" class="input input-sm" @change="onNewFile" />
            </label>
            <button class="btn-primary btn-sm" :disabled="creating" @click="createFile">{{ creating ? '写入中…' : '写入' }}</button>
          </div>
        </section>

        <section class="card">
          <template v-if="!current">
            <UiEmpty title="选择一个文件" text="左侧点开分类字典、legado 书源或版本日志即可查看与编辑。" />
          </template>
          <template v-else>
          <div class="flex flex-wrap items-center gap-2 mb-3">
            <input v-model="editSource" list="static-sources" class="input input-sm w-32 font-mono" aria-label="源名" />
            <span class="text-text-muted">/</span>
            <input v-model="editName" class="input input-sm w-48 font-mono" aria-label="文件名" />
            <UiTag v-if="current.retired" tone="gray" label="已退役" />
            <UiTag v-else-if="current.category && current.category !== '其他'" tone="blue" :label="current.category" />
            <span class="text-xs text-text-muted">{{ formatSize(current.size) }} · {{ fmtDate(current.mtime) }}</span>
            <span v-if="dirty" class="text-xs text-pale-yellow-fg">未保存</span>
            <button class="text-xs text-text-muted hover:text-text transition-colors ml-auto" @click="closeEditor">关闭</button>
          </div>
          <textarea v-model="current.content" spellcheck="false"
            class="input w-full font-mono text-xs leading-relaxed min-h-[28rem] bg-surface-alt" />
          <div class="flex flex-wrap items-center gap-2 mt-3">
            <button class="btn-primary btn-sm" :disabled="saving || !dirty" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
            <label class="btn-ghost btn-sm cursor-pointer">
              从本地文件替换
              <input type="file" class="hidden" @change="onReplaceFile" />
            </label>
            <button class="text-xs text-pale-red-fg hover:opacity-70 transition-opacity ml-auto" :disabled="saving" @click="remove">删除</button>
          </div>
          <p v-if="!current.servable" class="text-xs text-text-muted mt-3">这个文件不是 .json，只作备份保存；对外 /data 路由只提供 .json。</p>
        </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import PageHeader from '../../components/PageHeader.vue'
import UiSpinner from '../../components/UiSpinner.vue'
import UiEmpty from '../../components/UiEmpty.vue'
import UiTag from '../../components/UiTag.vue'
import { adminApi } from '../../api/index.js'
import { toast, revealObserve, fmtDate } from '../../utils.js'

const sources = ref([])
const knownSources = ref([])
const pendingDir = ref({})
const renamingDir = ref('')
const renameDirValue = ref('')
const loading = ref(true)
const error = ref('')
const filter = ref('')
const current = ref(null)
const original = ref('')
const saving = ref(false)
const editSource = ref('')
const editName = ref('')
const newSource = ref('')
const newFileName = ref('')
const newFile = ref(null)
const creating = ref(false)

const dirty = computed(() => !!current.value && (
  current.value.content !== original.value ||
  editSource.value !== current.value.source || editName.value !== current.value.filename
))
const knownWithoutDir = computed(() => knownSources.value.filter((k) => !k.has_dir))
const filteredSources = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return sources.value
  return sources.value
    .map((s) => ({ ...s, files: s.files.filter((f) => (s.source + '/' + f.filename).toLowerCase().includes(q)) }))
    .filter((s) => s.files.length)
})

const kindOf = (f) => {
  const n = String(f.filename || f.name || '')
  if (n === 'bookSource.json' || n.startsWith('bookSource.bak')) return 'legado 书源'
  if (n === 'version.json' || n.startsWith('version.bak')) return '版本日志'
  if (/(cats|ranks|tags|category)/i.test(n)) return '分类静态数据'
  return 'other'
}
const formatSize = (n) => Number(n || 0) >= 1024 ? (Number(n) / 1024).toFixed(1) + ' KB' : (n || 0) + ' B'
const isCurrent = (source, f) => current.value?.source === source && current.value?.name === f.filename

const load = async () => {
  loading.value = sources.value.length === 0
  error.value = ''
  try {
    const data = await adminApi.listStaticFiles()
    sources.value = data.sources || []
    knownSources.value = data.known_sources || []
    if (current.value) {
      const hit = sources.value.find((s) => s.source === current.value.source)?.files.find((f) => f.filename === current.value.name)
      if (hit) Object.assign(current.value, hit)
    }
  } catch (e) { error.value = e.message } finally { loading.value = false; nextTick(revealObserve) }
}

const openFile = async (source, f) => {
  saving.value = true
  try {
    const data = await adminApi.getStaticFile(source, f.filename)
    current.value = data
    original.value = data.content
    editSource.value = data.source
    editName.value = data.filename
  } catch (e) { toast(e.message, 'error') } finally { saving.value = false }
}

const startDirRename = (source) => {
  renamingDir.value = source
  renameDirValue.value = source
}
const renameDir = async () => {
  const from = renamingDir.value
  const to = renameDirValue.value.trim()
  if (!to) { toast('请输入新的目录名', 'error'); return }
  try {
    await adminApi.renameStaticSource(from, to)
    toast('目录已改名', 'success')
    if (current.value?.source === from) closeEditor()
    renamingDir.value = ''
    await load()
  } catch (e) { toast(e.message, 'error') }
}
const createDir = async (code) => {
  const to = (pendingDir.value[code] || '').trim() || code
  try {
    await adminApi.renameStaticSource(code, to)
    toast('静态目录已建立', 'success')
    await load()
  } catch (e) { toast(e.message, 'error') }
}

const closeEditor = () => {
  current.value = null
  original.value = ''
  editSource.value = ''
  editName.value = ''
}

const save = async () => {
  if (!dirty.value) return
  saving.value = true
  try {
    // 先写内容到原路径，再按需改名/换源：两步都在服务端校验，失败不会留下半个新文件
    const r = await adminApi.saveStaticFile(current.value.source, current.value.filename, current.value.content)
    Object.assign(current.value, r)
    if (editSource.value !== current.value.source || editName.value !== current.value.filename) {
      const moved = await adminApi.moveStaticFile(current.value.source, current.value.filename, editSource.value.trim(), editName.value.trim())
      Object.assign(current.value, moved)
    }
    original.value = current.value.content
    toast('已保存', 'success')
    await load()
  } catch (e) { toast(e.message, 'error') } finally { saving.value = false }
}

const remove = async () => {
  if (!window.confirm(`删除 ${current.value.source}/${current.value.name}？`)) return
  saving.value = true
  try {
    await adminApi.deleteStaticFile(current.value.source, current.value.filename)
    toast('已删除', 'success')
    current.value = null
    original.value = ''
    await load()
  } catch (e) { toast(e.message, 'error') } finally { saving.value = false }
}

const onReplaceFile = async (e) => {
  const file = e.target.files?.[0]
  if (!file || !current.value) return
  current.value.content = await file.text()
  e.target.value = ''
}

const onCreated = async (source, name) => {
  await load()
  const f = sources.value.find((s) => s.source === source)?.files.find((x) => x.filename === name)
  if (f) await openFile(source, f)
}

// 新文件表单：源名完全手动输入，datalist 只做已有源名提示，不强制回填
const onNewFile = (e) => {
  newFile.value = e.target.files?.[0] ?? null
  if (newFile.value && !newFileName.value) newFileName.value = newFile.value.name
}
const createFile = async () => {
  const s = newSource.value.trim(), n = newFileName.value.trim()
  if (!s || !n) { toast('请填写源名与文件名', 'error'); return }
  if (!newFile.value) { toast('请选择本地文件', 'error'); return }
  creating.value = true
  try {
    await adminApi.saveStaticFile(s, n, await newFile.value.text())
    toast('已写入', 'success')
    newFile.value = null
    await onCreated(s, n)
  } catch (e) { toast(e.message, 'error') } finally { creating.value = false }
}

onMounted(async () => { revealObserve(); await load() })
</script>
