import { createRouter, createWebHistory } from 'vue-router'
import { ready, refreshSession, user } from '@/composables/useSession'
import { onAuthError } from '@/lib/api'
import type { Role } from '@/lib/types'

const AppLayout = () => import('@/components/AppLayout.vue')
const MANAGERS: Role[] = ['admin', 'reseller']

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/pages/Login.vue'), meta: { open: true, title: 'Sign in' } },
    { path: '/password', component: () => import('@/pages/ForcePassword.vue'), meta: { title: 'Choose your password' } },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', component: () => import('@/pages/Dashboard.vue'), meta: { title: 'Dashboard' } },
        { path: 'accounts', component: () => import('@/pages/Accounts.vue'), meta: { title: 'Accounts', roles: MANAGERS } },
        { path: 'accounts/:id', component: () => import('@/pages/AccountDetail.vue'), meta: { title: 'Account', roles: MANAGERS } },
        { path: 'plans', component: () => import('@/pages/Plans.vue'), meta: { title: 'Plans', roles: MANAGERS } },
        { path: 'server', component: () => import('@/pages/Server.vue'), meta: { title: 'Server', roles: ['admin'] } },
        { path: 'settings', component: () => import('@/pages/Settings.vue'), meta: { title: 'Panel settings', roles: ['admin'] } },
        { path: 'activity', component: () => import('@/pages/Activity.vue'), meta: { title: 'Activity' } },
        { path: 'account', component: () => import('@/pages/MyAccount.vue'), meta: { title: 'My account' } },
      ],
    },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  if (!ready.value) await refreshSession()
  const u = user.value
  if (to.meta.open) return u ? { path: '/' } : true
  if (!u) return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} }
  if (u.mustChangePassword && !to.path.startsWith('/password')) return { path: '/password' }
  const roles = to.matched.map((r) => r.meta.roles as Role[] | undefined).find(Boolean)
  if (roles && !roles.includes(u.role)) return { path: '/' }
  return true
})

onAuthError((error) => {
  if (error.status === 401) {
    user.value = null
    if (!router.currentRoute.value.meta.open) void router.push('/login')
  } else if (error.code === 'must_change_password') {
    void refreshSession().then(() => router.push('/password'))
  }
})
