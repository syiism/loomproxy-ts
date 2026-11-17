import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from './api/client.ts'

const routes = [
  { path: '/', redirect: '/datasources' },
  { path: '/login', name: 'login', component: () => import('./pages/Login.vue'), meta: { public: true } },
  { path: '/datasources', name: 'datasources', component: () => import('./pages/Datasources.vue'), meta: { public: true } },
  { path: '/plugins', name: 'plugins', component: () => import('./pages/Plugins.vue') },
  { path: '/monitor', name: 'monitor', component: () => import('./pages/Monitor.vue') },
  // 未知路径回数据源页（面板挂在 /panel 下，深层链接由前端接管）
  { path: '/:pathMatch(.*)*', redirect: '/datasources' },
]

export const router = createRouter({
  // 与 Go 版同路径：面板挂在 /panel 下
  history: createWebHistory('/panel'),
  routes,
})

router.beforeEach((to) => {
  if (to.meta.public) return true
  if (!getToken()) return { name: 'login', query: { next: to.fullPath } }
  return true
})
