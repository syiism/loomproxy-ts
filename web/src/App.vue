<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authApi } from './api/index.ts'
import { clearToken, getToken } from './api/client.ts'

const route = useRoute()
const router = useRouter()
const me = ref<{ username: string; roles: string[] } | null>(null)
const loggedIn = computed(() => !!getToken())
const isAdmin = computed(() => me.value?.roles.includes('admin') ?? false)

async function refreshMe() {
  if (!getToken()) {
    me.value = null
    return
  }
  try {
    me.value = await authApi.me()
  } catch {
    me.value = null
  }
}

async function logout() {
  try {
    await authApi.logout()
  } catch {
    /* 登出失败也照样清本地票 */
  }
  clearToken()
  me.value = null
  void router.push({ name: 'login' })
}

onMounted(refreshMe)
// 路由变化时刷新身份（登录后会走这里）
router.afterEach(() => void refreshMe())

const current = computed(() => route.name)
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="dot"></span>
        <strong>LoomProxy</strong>
        <span class="muted">TS</span>
      </div>
      <nav>
        <RouterLink :class="{ active: current === 'datasources' }" to="/datasources">数据源</RouterLink>
        <RouterLink :class="{ active: current === 'plugins' }" to="/plugins">源插件</RouterLink>
        <RouterLink :class="{ active: current === 'monitor' }" to="/monitor">调用明细</RouterLink>
      </nav>
      <div class="who">
        <template v-if="loggedIn && me">
          <span class="chip">{{ me.username }}<em v-if="isAdmin">管理员</em></span>
          <button class="link" @click="logout">退出</button>
        </template>
        <RouterLink v-else class="link" to="/login">登录</RouterLink>
      </div>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>
