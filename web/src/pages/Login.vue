<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authApi } from '../api/index.ts'
import { setToken } from '../api/client.ts'

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const route = useRoute()
const router = useRouter()

async function submit() {
  busy.value = true
  error.value = ''
  try {
    const data = await authApi.login(username.value.trim(), password.value)
    setToken(data.token)
    const next = typeof route.query.next === 'string' ? route.query.next : '/plugins'
    await router.push(next)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="card">
      <h1>登录面板</h1>
      <p class="muted">账号来自部署的 <code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code>。</p>
      <form @submit.prevent="submit">
        <div class="field">
          <label>用户名</label>
          <input v-model="username" autocomplete="username" placeholder="admin" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" autocomplete="current-password" />
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <button class="btn" type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
      </form>
    </div>
  </div>
</template>
