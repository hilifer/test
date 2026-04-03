interface User {
  id: number
  username: string
  email: string
  full_name: string
  is_active: boolean
  is_superuser: boolean
  created_at: string
  updated_at: string
}

interface LoginData {
  username: string
  password: string
}

interface RegisterData {
  username: string
  email: string
  password: string
  full_name: string
}

interface UserSession {
  id: number
  device_info: string
  ip_address: string
  is_current: boolean
  created_at: string
  last_active_at: string
}

export const useAuth = () => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase
  const user = useState<User | null>('auth_user', () => null)
  const token = useCookie('auth_token', { maxAge: 60 * 60 * 24 })

  const isLoggedIn = computed(() => !!token.value && !!user.value)
  const isAdmin = computed(() => user.value?.is_superuser ?? false)

  async function apiFetch<T>(url: string, opts: any = {}): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers }
    if (token.value) {
      headers['Authorization'] = `Bearer ${token.value}`
    }
    return await $fetch<T>(url, {
      baseURL: apiBase,
      ...opts,
      headers,
    })
  }

  async function login(data: LoginData) {
    const res = await apiFetch<{ access_token: string }>('/api/auth/login', {
      method: 'POST',
      body: data,
    })
    token.value = res.access_token
    await fetchUser()
  }

  async function register(data: RegisterData) {
    await apiFetch('/api/auth/register', {
      method: 'POST',
      body: data,
    })
  }

  async function fetchUser() {
    if (!token.value) return
    try {
      user.value = await apiFetch<User>('/api/users/me')
    } catch {
      logout()
    }
  }

  async function updateProfile(data: { email?: string; full_name?: string }) {
    user.value = await apiFetch<User>('/api/users/me', {
      method: 'PUT',
      body: data,
    })
  }

  async function changePassword(old_password: string, new_password: string) {
    await apiFetch('/api/users/me/change-password', {
      method: 'POST',
      body: { old_password, new_password },
    })
  }

  async function logout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore errors during logout
    }
    token.value = null
    user.value = null
    navigateTo('/login')
  }

  async function listSessions(): Promise<UserSession[]> {
    return await apiFetch<UserSession[]>('/api/sessions/')
  }

  async function revokeSession(sessionId: number) {
    await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
  }

  async function revokeOtherSessions() {
    await apiFetch('/api/sessions/', { method: 'DELETE' })
  }

  return {
    user,
    token,
    isLoggedIn,
    isAdmin,
    login,
    register,
    fetchUser,
    updateProfile,
    changePassword,
    logout,
    listSessions,
    revokeSession,
    revokeOtherSessions,
    apiFetch,
  }
}
